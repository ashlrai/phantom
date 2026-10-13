/**
 * Independent local replay custody, stored beside (never inside) a ledger.
 * Reserve before publishing a ledger revision under the caller's existing writer lock.
 * Readers must match this head to their complete ledger. A reservation without a
 * matching ledger is held, never a reason to automatically replay work.
 * This protects against ledger-only prefix deletion and interrupted publication;
 * it is neither external admission nor protection against the same OS user
 * deleting/replacing both the ledger and its watermark custody.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';

export interface ReplayWatermarkLimits { maxRecords: number; maxBytes?: number }
export interface ReplayWatermarkReservation { revision: number; ledgerDigest: string; previousLedgerDigest: string | null }
export interface ReplayWatermarkRead { sourceState: 'healthy' | 'missing' | 'degraded'; revision: number; ledgerDigest: string | null }
export type ReplayWatermarkDisposition = 'recorded' | 'replayed' | 'conflict' | 'unavailable';
interface WatermarkRecord extends ReplayWatermarkReservation {
  schemaVersion: 1; previousWatermarkDigest: string | null; digest: string;
}
const RECORD_BYTES = 1024, HARD_RECORDS = 100_000, HARD_BYTES = 64 * 1024 * 1024;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor && 'value' in descriptor;
  });
}
function validReservation(value: unknown): value is ReplayWatermarkReservation {
  if (!exact(value, ['revision', 'ledgerDigest', 'previousLedgerDigest'])) return false;
  return Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 && hash(value.ledgerDigest) &&
    (value.previousLedgerDigest === null || hash(value.previousLedgerDigest));
}
function normalizedLimits(value: ReplayWatermarkLimits): Required<ReplayWatermarkLimits> | null {
  if (!value || typeof value !== 'object') return null;
  const maxBytesDescriptor = Object.getOwnPropertyDescriptor(value, 'maxBytes');
  if (!exact(value, maxBytesDescriptor ? ['maxRecords', 'maxBytes'] : ['maxRecords']) ||
    !Number.isSafeInteger(value.maxRecords) || value.maxRecords < 1 || value.maxRecords > HARD_RECORDS) return null;
  const maxBytes = value.maxBytes ?? Math.min(HARD_BYTES, value.maxRecords * RECORD_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_BYTES) return null;
  return { maxRecords: value.maxRecords, maxBytes };
}
function payload(record: Omit<WatermarkRecord, 'digest'>): Omit<WatermarkRecord, 'digest'> {
  return { schemaVersion: 1, revision: record.revision, ledgerDigest: record.ledgerDigest,
    previousLedgerDigest: record.previousLedgerDigest, previousWatermarkDigest: record.previousWatermarkDigest };
}
function digest(value: Omit<WatermarkRecord, 'digest'>): string { return createHash('sha256').update(JSON.stringify(payload(value))).digest('hex'); }
function parse(value: unknown): WatermarkRecord | null {
  if (!exact(value, ['schemaVersion', 'revision', 'ledgerDigest', 'previousLedgerDigest', 'previousWatermarkDigest', 'digest']) ||
    value.schemaVersion !== 1 || !validReservation({ revision: value.revision, ledgerDigest: value.ledgerDigest, previousLedgerDigest: value.previousLedgerDigest }) ||
    !(value.previousWatermarkDigest === null || hash(value.previousWatermarkDigest)) || !hash(value.digest)) return null;
  const record = value as unknown as WatermarkRecord;
  return digest(record) === record.digest ? record : null;
}
const codec: ImmutablePrivateRecordCodec<WatermarkRecord> = {
  parse, serialize: record => `${JSON.stringify({ ...payload(record), digest: record.digest })}\n`,
  recordId: record => String(record.revision), recordFileName: record => `${String(record.revision).padStart(16, '0')}.json`,
  isRecordFileName: name => /^[0-9]{16}\.json$/u.test(name), stageToken: record => record.digest,
  equivalent: (left, right) => left.digest === right.digest, compare: (left, right) => left.revision - right.revision,
};
function config(directory: string, limits: Required<ReplayWatermarkLimits>): ImmutablePrivateRecordStoreConfig<WatermarkRecord> {
  return { label: 'Local replay watermark', anchorPath: directory, rootPath: join(directory, 'replay-watermarks'), lockFileName: '.watermarks.lock',
    maxRecordBytes: RECORD_BYTES, defaultMaxFiles: limits.maxRecords, hardMaxFiles: limits.maxRecords,
    defaultMaxBytes: limits.maxBytes, hardMaxBytes: HARD_BYTES, codecForRead: () => codec, codecForWrite: () => codec };
}
function empty(sourceState: ReplayWatermarkRead['sourceState']): ReplayWatermarkRead { return { sourceState, revision: 0, ledgerDigest: null }; }
function read(directory: string, limits: Required<ReplayWatermarkLimits>): { view: ReplayWatermarkRead; records: WatermarkRecord[]; bytes: number } {
  try {
    inspectPrivateDirectory(directory);
    const snapshot = readImmutablePrivateRecords(config(directory, limits), { maxFiles: limits.maxRecords, maxBytes: limits.maxBytes, requireComplete: true });
    if (snapshot.sourceState === 'missing') return { view: empty('missing'), records: [], bytes: 0 };
    if (!snapshot.complete || snapshot.sourceState !== 'healthy') return { view: empty('degraded'), records: [], bytes: 0 };
    for (const [index, item] of snapshot.records.entries()) {
      const prior = snapshot.records[index - 1];
      if (item.revision !== index + 1 || item.previousLedgerDigest !== (prior?.ledgerDigest ?? null) ||
        item.previousWatermarkDigest !== (prior?.digest ?? null)) return { view: empty('degraded'), records: [], bytes: 0 };
    }
    const head = snapshot.records.at(-1);
    return { view: head ? { sourceState: 'healthy', revision: head.revision, ledgerDigest: head.ledgerDigest } : empty('missing'),
      records: snapshot.records, bytes: snapshot.bytesRead };
  } catch (error) {
    return { view: empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded'), records: [], bytes: 0 };
  }
}
/** Read-only, bounded, complete chain inspection. Never creates custody directories or recovers staging. */
export function readReplayWatermark(directory: string, limits: ReplayWatermarkLimits): ReplayWatermarkRead {
  try {
    const normalized = normalizedLimits(limits); return normalized ? read(directory, normalized).view : empty('degraded');
  } catch { return empty('degraded'); }
}
/** Caller owns the outer ledger writer lock and has already matched its complete ledger to the watermark head. */
export function reserveReplayWatermark(directory: string, reservation: ReplayWatermarkReservation,
  limits: ReplayWatermarkLimits = { maxRecords: 1024 }): ReplayWatermarkDisposition {
  try {
    const normalized = normalizedLimits(limits);
    if (!normalized || !validReservation(reservation)) return 'unavailable';
    // Input contains no user text/credentials and is copied before I/O.
    const requested = { revision: reservation.revision, ledgerDigest: reservation.ledgerDigest, previousLedgerDigest: reservation.previousLedgerDigest };
    inspectPrivateDirectory(directory);
    const current = read(directory, normalized);
    if (current.view.sourceState === 'degraded') return 'unavailable';
    const head = current.records.at(-1);
    if (requested.revision === current.view.revision) return head && requested.ledgerDigest === head.ledgerDigest &&
      requested.previousLedgerDigest === head.previousLedgerDigest ? 'replayed' : 'conflict';
    if (requested.revision !== current.view.revision + 1 || requested.previousLedgerDigest !== current.view.ledgerDigest) return 'conflict';
    if (current.records.length >= normalized.maxRecords) return 'unavailable';
    const content = payload({ schemaVersion: 1, ...requested, previousWatermarkDigest: head?.digest ?? null });
    const record = { ...content, digest: digest(content) };
    if (current.bytes + Buffer.byteLength(codec.serialize(record)) > normalized.maxBytes) return 'unavailable';
    // Immutable no-clobber publication performs private/no-follow checks and fsyncs.
    // No recovery is invoked here: orphaned stages remain degraded for explicit reconciliation.
    const disposition = writeImmutablePrivateRecord(config(directory, normalized), record, { lockWaitMs: 0 });
    if (disposition === 'conflicted') return 'conflict';
    if (disposition !== 'recorded' && disposition !== 'replayed') return 'unavailable';
    const confirmed = read(directory, normalized).view;
    return confirmed.sourceState === 'healthy' && confirmed.revision === requested.revision && confirmed.ledgerDigest === requested.ledgerDigest
      ? disposition : 'unavailable';
  } catch { return 'unavailable'; }
}
