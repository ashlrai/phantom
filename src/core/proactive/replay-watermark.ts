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
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory, privateDirectory } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { canonicalJson, hasPlainDataKeys, isSha256Hex } from './validation.js';

export interface ReplayWatermarkLimits { maxRecords: number; maxBytes?: number }
export interface ReplayWatermarkReservation { revision: number; ledgerDigest: string; previousLedgerDigest: string | null }
export interface ReplayWatermarkRead { sourceState: 'healthy' | 'missing' | 'degraded'; revision: number; ledgerDigest: string | null }
export type ReplayWatermarkDisposition = 'recorded' | 'replayed' | 'conflict' | 'unavailable';
export interface RevisionRecord { revision: number; digest: string }
export interface ChainedRevisionRecord extends RevisionRecord { previousDigest: string | null }
export interface WatermarkedLedgerConfigOptions<T extends ChainedRevisionRecord> {
  label: string; directory: string; maxRecordBytes: number; maxRecords: number;
  maxAggregateBytes: number; codec: ImmutablePrivateRecordCodec<T>;
}
export interface WatermarkedLedgerRead<T extends ChainedRevisionRecord> { sourceState: 'healthy' | 'missing' | 'degraded'; records: T[] }
export type WatermarkedLedgerCommitOutcome<T extends ChainedRevisionRecord, TResult> =
  | { kind: 'short-circuit'; value: TResult }
  | { kind: 'commit'; record: T };
export interface WatermarkedLedgerCommitOptions<T extends ChainedRevisionRecord, TResult> {
  directory: string; lockFileName: string; config: ImmutablePrivateRecordStoreConfig<T>; maxRecords: number;
  read: () => WatermarkedLedgerRead<T>; allowReplayedWatermark?: boolean; mapConflictDisposition?: boolean;
  fail: (reason: 'conflict' | 'unavailable') => TResult;
  prepare: (records: T[]) => WatermarkedLedgerCommitOutcome<T, TResult>;
  onCommitted: (record: T, disposition: 'recorded' | 'replayed') => TResult;
}
interface WatermarkRecord extends ReplayWatermarkReservation {
  schemaVersion: 1; previousWatermarkDigest: string | null; digest: string;
}
const RECORD_BYTES = 1024, HARD_RECORDS = 100_000, HARD_BYTES = 64 * 1024 * 1024;
/** Shared 16-digit zero-padded revision codec for immutable private proactive ledgers. */
export function createRevisionRecordCodec<T extends RevisionRecord>(
  parse: (value: unknown) => T | null,
  serialize: (value: T) => string = value => `${canonicalJson(value)}\n`,
): ImmutablePrivateRecordCodec<T> {
  return {
    parse, serialize, recordId: value => String(value.revision),
    recordFileName: value => `${String(value.revision).padStart(16, '0')}.json`,
    isRecordFileName: name => /^\d{16}\.json$/.test(name), stageToken: value => value.digest,
    equivalent: (left, right) => left.digest === right.digest, compare: (left, right) => left.revision - right.revision,
  };
}
/** Shared config for a watermarked immutable private ledger stored under `<directory>/ledger`. */
export function createWatermarkedLedgerConfig<T extends ChainedRevisionRecord>(
  options: WatermarkedLedgerConfigOptions<T>,
): ImmutablePrivateRecordStoreConfig<T> {
  return {
    label: options.label, anchorPath: options.directory, rootPath: join(options.directory, 'ledger'), lockFileName: '.records.lock',
    maxRecordBytes: options.maxRecordBytes, defaultMaxFiles: options.maxRecords, hardMaxFiles: options.maxRecords,
    defaultMaxBytes: options.maxAggregateBytes, hardMaxBytes: options.maxAggregateBytes,
    codecForRead: () => options.codec, codecForWrite: () => options.codec,
  };
}
/** Read a complete watermarked revision chain and verify privacy, head alignment, links, and domain invariants. */
export function readWatermarkedLedger<T extends ChainedRevisionRecord>(
  directory: string, storeConfig: ImmutablePrivateRecordStoreConfig<T>, maxRecords: number,
  verifyTransition: (record: T, previous: T | undefined, index: number, records: readonly T[]) => boolean,
): WatermarkedLedgerRead<T> {
  try {
    inspectPrivateDirectory(directory);
    const watermark = readReplayWatermark(directory, { maxRecords });
    if (watermark.sourceState === 'degraded') return { sourceState: 'degraded', records: [] };
    const snapshot = readImmutablePrivateRecords(storeConfig, { requireComplete: true });
    if (snapshot.sourceState === 'missing') return { sourceState: watermark.sourceState === 'missing' ? 'missing' : 'degraded', records: [] };
    if (!snapshot.complete || snapshot.sourceState !== 'healthy') return { sourceState: 'degraded', records: [] };
    const head = snapshot.records.at(-1);
    if (head ? watermark.sourceState !== 'healthy' || watermark.revision !== head.revision || watermark.ledgerDigest !== head.digest : watermark.sourceState !== 'missing') {
      return { sourceState: 'degraded', records: [] };
    }
    for (const [index, record] of snapshot.records.entries()) {
      const previous = snapshot.records[index - 1];
      if (record.revision !== index + 1 || record.previousDigest !== (previous?.digest ?? null) || !verifyTransition(record, previous, index, snapshot.records)) {
        return { sourceState: 'degraded', records: [] };
      }
    }
    return { sourceState: snapshot.records.length ? 'healthy' : 'missing', records: snapshot.records };
  } catch (error) { return { sourceState: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded', records: [] }; }
}
/** Lock, check degradation, recover staging, reserve watermark, and publish one immutable revision record. */
export function commitWatermarkedLedgerRecord<T extends ChainedRevisionRecord, TResult>(
  options: WatermarkedLedgerCommitOptions<T, TResult>,
): TResult {
  try { privateDirectory(options.directory); } catch { return options.fail('unavailable'); }
  const acquired = acquireLocalStoreLockWithOutcome(join(options.directory, options.lockFileName), 0, { anchorPath: options.directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') return options.fail(acquired.state === 'contended' ? 'conflict' : 'unavailable');
  try {
    // Reservation gaps and truncated prefixes are never repaired into fresh permission.
    if (options.read().sourceState === 'degraded') return options.fail('unavailable');
    if (!['clean', 'recovered', 'missing'].includes(recoverImmutablePrivateRecordStore(options.config))) return options.fail('unavailable');
    const current = options.read();
    if (current.sourceState === 'degraded') return options.fail('unavailable');
    const outcome = options.prepare(current.records);
    if (outcome.kind === 'short-circuit') return outcome.value;
    const { record } = outcome;
    if (!ownsLocalStoreLock(acquired.lock)) return options.fail('unavailable');
    const reserved = reserveReplayWatermark(options.directory, { revision: record.revision, ledgerDigest: record.digest, previousLedgerDigest: record.previousDigest }, { maxRecords: options.maxRecords });
    if (!(options.allowReplayedWatermark ? reserved === 'recorded' || reserved === 'replayed' : reserved === 'recorded')) return options.fail('unavailable');
    const disposition = writeImmutablePrivateRecord(options.config, record, { prepublish: () => ownsLocalStoreLock(acquired.lock) });
    if (disposition !== 'recorded' && disposition !== 'replayed') return options.fail(options.mapConflictDisposition && disposition === 'conflicted' ? 'conflict' : 'unavailable');
    return options.onCommitted(record, disposition);
  } catch { return options.fail('unavailable'); } finally { releaseLocalStoreLock(acquired.lock); }
}
function validReservation(value: unknown): value is ReplayWatermarkReservation {
  if (!hasPlainDataKeys(value, ['revision', 'ledgerDigest', 'previousLedgerDigest'])) return false;
  return Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 && isSha256Hex(value.ledgerDigest) &&
    (value.previousLedgerDigest === null || isSha256Hex(value.previousLedgerDigest));
}
function normalizedLimits(value: ReplayWatermarkLimits): Required<ReplayWatermarkLimits> | null {
  if (!value || typeof value !== 'object') return null;
  const maxBytesDescriptor = Object.getOwnPropertyDescriptor(value, 'maxBytes');
  if (!hasPlainDataKeys(value, maxBytesDescriptor ? ['maxRecords', 'maxBytes'] : ['maxRecords']) ||
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
  if (!hasPlainDataKeys(value, ['schemaVersion', 'revision', 'ledgerDigest', 'previousLedgerDigest', 'previousWatermarkDigest', 'digest']) ||
    value.schemaVersion !== 1 || !validReservation({ revision: value.revision, ledgerDigest: value.ledgerDigest, previousLedgerDigest: value.previousLedgerDigest }) ||
    !(value.previousWatermarkDigest === null || isSha256Hex(value.previousWatermarkDigest)) || !isSha256Hex(value.digest)) return null;
  const record = value as unknown as WatermarkRecord;
  return digest(record) === record.digest ? record : null;
}
const codec = createRevisionRecordCodec(parse, record => `${JSON.stringify({ ...payload(record), digest: record.digest })}\n`);
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
