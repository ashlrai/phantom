/**
 * Local durable bus mailboxes. Routing labels identify queues, not authenticated
 * callers. No remote delivery, engine execution or authority is implied.
 * Immutable messages and acknowledgments retain history; reads never repair it.
 */
import { createHash } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  readImmutablePrivateRecords, recoverImmutablePrivateRecordStore, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';

type Message = { v: 1; kind: 'message'; acceptedAt: number; envelope: BusEnvelope };
type Ack = { v: 1; kind: 'ack'; id: string; to: string };
type RecordEntry = Message | Ack;

export class BusMailboxError extends Error {
  constructor(readonly code: 'invalid-envelope' | 'credentials' | 'storage' | 'capacity' | 'conflict' | 'not-found' | 'invalid-address') {
    const messages = {
      'invalid-envelope': 'Invalid bus envelope.',
      credentials: 'Credential-shaped data refused. Use a Phantom Secrets phm_<name> reference.',
      storage: 'Bus storage unavailable or incomplete; retry or inspect the local store.',
      capacity: 'Bus history capacity reached. Existing messages remain readable and acknowledgeable; use a new bus home for new traffic.',
      conflict: 'Message ID already exists with different contents.',
      'not-found': 'Message not found for this recipient.',
      'invalid-address': 'Expected a printable ASCII routing label of 1 to 128 characters.',
    };
    super(messages[code]);
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function key(record: RecordEntry): string {
  return record.kind === 'message' ? `m-${digest(record.envelope.id)}` : `a-${digest(JSON.stringify([record.id, record.to]))}`;
}
function credentialFree(value: unknown): boolean {
  const text = JSON.stringify(value);
  return scrubSecrets(text) === text;
}
export function validateBusAddress(value: string): void {
  if (!/^[\x21-\x7e]{1,128}(?![\s\S])/.test(value)) throw new BusMailboxError('invalid-address');
  if (!credentialFree(value)) throw new BusMailboxError('credentials');
}

function parseRecord(value: unknown): RecordEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1) return null;
  if (row.kind === 'message' && Object.keys(row).sort().join(',') === 'acceptedAt,envelope,kind,v') {
    const checked = validateBusEnvelope(row.envelope);
    if (!checked.ok || !credentialFree(checked.value) || !Number.isSafeInteger(row.acceptedAt) ||
      (row.acceptedAt as number) < 0) return null;
    return { v: 1, kind: 'message', acceptedAt: row.acceptedAt as number, envelope: checked.value };
  }
  if (row.kind === 'ack' && Object.keys(row).sort().join(',') === 'id,kind,to,v' &&
    typeof row.id === 'string' && typeof row.to === 'string') {
    try { validateBusAddress(row.id); validateBusAddress(row.to); } catch { return null; }
    return { v: 1, kind: 'ack', id: row.id, to: row.to };
  }
  return null;
}

const codec: ImmutablePrivateRecordCodec<RecordEntry> = {
  parse: parseRecord,
  serialize: record => JSON.stringify(record) + '\n',
  recordId: key,
  recordFileName: record => `${key(record)}.json`,
  isRecordFileName: name => /^[ma]-[a-f0-9]{64}\.json$/.test(name),
  stageToken: record => digest(JSON.stringify(record)),
  // Retrying the same send must neither conflict on nor renew its acceptance time.
  equivalent: (left, right) => left.kind === 'message' && right.kind === 'message'
    ? JSON.stringify(left.envelope) === JSON.stringify(right.envelope)
    : JSON.stringify(left) === JSON.stringify(right),
};

export interface BusMailbox {
  send(envelope: BusEnvelope): { id: string; replayed: boolean };
  inbox(to: string, limit?: number): { messages: BusEnvelope[]; hasMore: boolean };
  ack(id: string, to: string): { id: string; acknowledged: true; replayed: boolean };
}

/** Same-user cooperative transport, backed by the shared crash-safe private store. */
export function createBusMailbox(
  home = ashlrHome(), now: () => number = Date.now,
  limits: { maxMessages?: number; maxBytes?: number } = {},
): BusMailbox {
  // Only lowering these bounds is supported. Each accepted send reserves an
  // acknowledgment slot and its worst-case encoded bytes, even after expiry.
  const maxMessages = limits.maxMessages ?? 5000;
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 5000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new BusMailboxError('storage');
  const config: ImmutablePrivateRecordStoreConfig<RecordEntry> = {
    label: 'bus mailbox', anchorPath: home, rootPath: join(home, 'bus'), lockFileName: '.bus.lock',
    maxRecordBytes: 66 * 1024, defaultMaxFiles: 10_000, hardMaxFiles: 10_000,
    defaultMaxBytes: 64 * 1024 * 1024, hardMaxBytes: 64 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec,
  };
  const read = (): RecordEntry[] => {
    // existsSync (used by the generic reader) treats dangling links and some
    // I/O failures as absence. Check them explicitly before accepting empty.
    for (const path of [home, config.rootPath]) {
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BusMailboxError('storage');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new BusMailboxError('storage');
      }
    }
    const result = readImmutablePrivateRecords(config, { requireComplete: true });
    if (result.sourceState === 'missing') return [];
    if (!result.complete || result.sourceState === 'degraded') throw new BusMailboxError('storage');
    return result.records;
  };
  const write = (record: RecordEntry): boolean => {
    try { ensurePrivateDirectory(home); } catch { throw new BusMailboxError('storage'); }
    let capacity = false;
    const prepublish = (): boolean => {
      const directory = join(config.rootPath, 'records');
      const target = codec.recordFileName(record);
      let files = 0; let messages = 0; let bytes = 0; let exists = false;
      const dir = opendirSync(directory);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++files > 10_000 || !codec.isRecordFileName(entry.name)) return false;
          const stat = lstatSync(join(directory, entry.name));
          // A two-link record may be an interrupted publication. The shared
          // writer validates and recovers that exact stage/target pair next.
          if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && stat.nlink !== 2)) return false;
          bytes += stat.size;
          if (entry.name.startsWith('m-')) messages++;
          if (entry.name === target) exists = true;
        }
      } finally { dir.closeSync(); }
      // Runs under the store's publication lock, so cooperating sends cannot
      // race the budget. Replays and acks consume no new message reservation.
      if (exists || record.kind === 'ack') return true;
      capacity = messages >= maxMessages || bytes + (messages + 1) * 1024 +
        Buffer.byteLength(codec.serialize(record)) > maxBytes;
      return !capacity;
    };
    let result = writeImmutablePrivateRecord(config, record, { prepublish });
    // First-use directory creation happens before the shared publication lock.
    // Retrying a raced initialization or uncertain write is safe by immutable ID.
    for (let retry = 0; result === 'failed' && !capacity && retry < 2; retry++) {
      result = writeImmutablePrivateRecord(config, record, { prepublish });
    }
    if (capacity) {
      // Admission may refuse before the writer reaches its recovery pass.
      // Finalize already-linked history even at capacity so pending messages
      // stay readable; never publish an unlinked stage during this repair.
      const recovery = recoverImmutablePrivateRecordStore(config);
      if (recovery !== 'clean' && recovery !== 'recovered') throw new BusMailboxError('storage');
      throw new BusMailboxError('capacity');
    }
    if (result === 'conflicted') throw new BusMailboxError('conflict');
    if (result !== 'recorded' && result !== 'replayed') throw new BusMailboxError('storage');
    return result === 'replayed';
  };
  return {
    send(input) {
      const checked = validateBusEnvelope(input);
      if (!checked.ok) throw new BusMailboxError('invalid-envelope');
      if (!credentialFree(checked.value)) throw new BusMailboxError('credentials');
      const acceptedAt = now();
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) throw new BusMailboxError('storage');
      return { id: checked.value.id, replayed: write({ v: 1, kind: 'message', acceptedAt, envelope: checked.value }) };
    },
    inbox(to, limit = 100) {
      validateBusAddress(to);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new BusMailboxError('invalid-envelope');
      const records = read();
      const acked = new Set(records.filter((r): r is Ack => r.kind === 'ack' && r.to === to).map(r => r.id));
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) throw new BusMailboxError('storage');
      const pending = records.filter((r): r is Message => r.kind === 'message' && r.envelope.to === to &&
        !acked.has(r.envelope.id) && at >= r.acceptedAt && at - r.acceptedAt < r.envelope.ttl);
      pending.sort((a, b) => a.envelope.priority.localeCompare(b.envelope.priority) ||
        a.acceptedAt - b.acceptedAt || a.envelope.id.localeCompare(b.envelope.id));
      return {
        messages: pending.slice(0, limit).map(r => ({ ...r.envelope, ttl: r.envelope.ttl - (at - r.acceptedAt) })),
        hasMore: pending.length > limit,
      };
    },
    ack(id, to) {
      validateBusAddress(id); validateBusAddress(to);
      // Immutable send slots make this read-before-write safe across cooperating
      // send/ack processes: a verified message cannot later change recipients.
      const message = read().find((r): r is Message => r.kind === 'message' && r.envelope.id === id && r.envelope.to === to);
      if (!message) throw new BusMailboxError('not-found');
      return { id, acknowledged: true, replayed: write({ v: 1, kind: 'ack', id, to }) };
    },
  };
}
