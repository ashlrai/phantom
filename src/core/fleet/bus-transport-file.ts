/**
 * File-bus transport: the local bus inbox (`<root>/bus-inbox`) as a
 * {@link BusTransport}. Sends are `appendBusInbox` posts and polls are cursor
 * pages, so there is no second message store (docs/AGENT-BUS.md). The only new
 * state is a bounded ack ledger at `<root>/bus-transport/acks.json`, pruned to
 * messages the inbox still retains alive. Dead letters are posted back into the
 * same inbox under {@link BUS_DEAD_LETTER_ADDRESS}.
 *
 * Local only: this transport never leaves the machine. Bodies are untrusted.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { localWriteGate } from '../agents/send-gate.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import {
  BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  appendBusInbox, assertPrivateBusPath, busPathMissing, inspectBusInbox, listBusInboxAfter,
  type BusInboxOptions, type BusInboxReceipt,
} from './bus-inbox.js';
import {
  checkTransportEnvelope, fromBusEnvelope, roleMatches, toBusEnvelope,
  type BusTransport, type DeadLetter, type DeadLetterSink, type TransportAckResult,
  type TransportEnvelope, type TransportHealth, type TransportMessage, type TransportPollResult,
  type TransportSendResult,
} from './bus-transport.js';

export const FILE_BUS_TRANSPORT_ID = 'file-bus';
/** Reserved routing label for dead letters on the file bus. */
export const BUS_DEAD_LETTER_ADDRESS = 'bus.dead-letter';
export const BUS_DEAD_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Retained inbox share at which the transport reports `degraded`. */
const DEGRADED_SHARE = 0.9;
const ACK_LEDGER_VERSION = 1;
const ACK_LEDGER_MAX_BYTES = 512 * 1024;

export interface FileBusTransportOptions extends BusInboxOptions {
  /**
   * Routing labels this consumer reads and acks: exact labels or `prefix*`.
   * Sends are not limited by it; the router decides which roles reach here.
   */
  addresses: readonly string[];
  /** Transport id; defaults to `file-bus`. */
  id?: string;
  /** Envelopes per poll page, 1 to 100. Default 50. */
  pageSize?: number;
}

interface AckRow { id: string; to: string }

function rootOf(options: BusInboxOptions): string { return options.root ?? join(ashlrHome(), 'fleet'); }

function ledgerPaths(root: string) {
  const directory = join(root, 'bus-transport');
  return { directory, file: join(directory, 'acks.json'), pending: join(directory, '.pending'), lock: join(directory, 'writer.lock') };
}

/** Throws on damage; returns [] when the ledger was never written. */
function readAckLedger(root: string): AckRow[] {
  const paths = ledgerPaths(root);
  if (busPathMissing(root) || busPathMissing(paths.directory) || busPathMissing(paths.file)) return [];
  assertPrivateBusPath(root, 'directory', root);
  assertPrivateBusPath(paths.directory, 'directory', root);
  assertPrivateBusPath(paths.file, 'file', root);
  const read = readStableRegularFile(paths.file, { anchorPath: root, maxFileBytes: ACK_LEDGER_MAX_BYTES, remainingBytes: ACK_LEDGER_MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const parsed: unknown = JSON.parse(read.text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join() !== 'acks,version' || (parsed as { version: unknown }).version !== ACK_LEDGER_VERSION) {
    throw new Error('Unavailable');
  }
  const acks = (parsed as { acks: unknown }).acks;
  if (!Array.isArray(acks) || acks.length > BUS_INBOX_MAX_MESSAGES) throw new Error('Unavailable');
  return acks.map((row: unknown) => {
    if (row === null || typeof row !== 'object' || Object.keys(row).sort().join() !== 'id,to' ||
      typeof (row as AckRow).id !== 'string' || typeof (row as AckRow).to !== 'string') throw new Error('Unavailable');
    return { id: (row as AckRow).id, to: (row as AckRow).to };
  });
}

const ackKey = (id: string, to: string) => JSON.stringify([id, to]);

/** Every live retained receipt, oldest first, bounded by the inbox's own caps. */
function liveReceipts(options: BusInboxOptions): BusInboxReceipt[] | 'retryable' | 'unavailable' {
  const rows: BusInboxReceipt[] = [];
  let after = 0;
  // The inbox retains at most BUS_INBOX_MAX_MESSAGES rows, so this terminates.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ, options);
    if (result.status === 'retryable') return 'retryable';
    if (result.status !== 'ok') return 'unavailable';
    rows.push(...result.messages);
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= after) return rows;
    after = result.nextCursor;
  }
  return rows;
}

export function createFileBusTransport(options: FileBusTransportOptions): BusTransport {
  const addresses = [...options.addresses];
  if (addresses.length === 0 || addresses.some(address => typeof address !== 'string' || address.length === 0)) {
    throw new TypeError('File bus transport needs at least one address.');
  }
  const pageSize = options.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > BUS_INBOX_MAX_READ) throw new TypeError('Invalid page size.');
  const inbox: BusInboxOptions = { root: options.root, now: options.now };
  const reads = (to: string) => addresses.some(pattern => roleMatches(pattern, to));

  async function send(input: TransportEnvelope): Promise<TransportSendResult> {
    const envelope = checkTransportEnvelope(input);
    const wire = envelope && toBusEnvelope(envelope);
    if (!wire) return { ok: false, retryable: false, reason: 'Invalid envelope.' };
    // Same gate as deliverLocalEnvelope, for callers that bypass the router.
    const blocked = localWriteGate();
    if (blocked) return { ok: false, retryable: true, reason: blocked.reason };
    const post = appendBusInbox(wire, inbox);
    switch (post.status) {
      case 'posted': case 'duplicate':
        return { ok: true, receipt: `cursor:${post.cursor}`, duplicate: post.status === 'duplicate' };
      case 'retryable': return { ok: false, retryable: true, reason: 'Bus inbox is busy.' };
      // Full clears as retained records expire; another transport may still carry it now.
      case 'full': return { ok: false, retryable: true, reason: 'Bus inbox is full.' };
      case 'unavailable': return { ok: false, retryable: true, reason: 'Bus inbox is unavailable.' };
      case 'conflict': return { ok: false, retryable: false, reason: 'Message id already used with different content.' };
      default: return { ok: false, retryable: false, reason: 'Bus inbox refused the envelope.' };
    }
  }

  async function poll(since?: string): Promise<TransportPollResult> {
    const after = since === undefined ? 0 : Number(since);
    if (since !== undefined && !/^(0|[1-9][0-9]{0,15})$/.test(since)) return { ok: false, retryable: false, reason: 'Invalid cursor.' };
    let acked: Set<string>;
    try { acked = new Set(readAckLedger(rootOf(inbox)).map(row => ackKey(row.id, row.to))); }
    catch { return { ok: false, retryable: false, reason: 'Ack ledger unavailable.' }; }
    const page = listBusInboxAfter(after, pageSize, inbox);
    if (page.status !== 'ok') {
      return { ok: false, retryable: page.status === 'retryable', reason: page.status === 'invalid' ? 'Invalid cursor.' : 'Bus inbox unavailable.' };
    }
    const messages: TransportMessage[] = [];
    for (const row of page.messages) {
      if (!reads(row.envelope.to) || acked.has(ackKey(row.envelope.id, row.envelope.to))) continue;
      const envelope = fromBusEnvelope(row.envelope);
      // Other bus traffic shares the inbox; only transport-shaped envelopes are returned.
      if (envelope) messages.push({ cursor: String(row.cursor), receivedAt: row.receivedAt, envelope });
    }
    return { ok: true, messages, next: String(page.nextCursor) };
  }

  async function ack(id: string): Promise<TransportAckResult> {
    if (typeof id !== 'string' || id.length === 0) return { ok: false, retryable: false, reason: 'Invalid id.' };
    const root = rootOf(inbox);
    const paths = ledgerPaths(root);
    try {
      ensurePrivateDirectory(root); assertPrivateBusPath(root, 'directory', root);
      ensurePrivateDirectory(paths.directory); assertPrivateBusPath(paths.directory, 'directory', root);
    } catch { return { ok: false, retryable: true, reason: 'Ack ledger unavailable.' }; }
    const acquired = acquireLocalStoreLockWithOutcome(paths.lock, 0, { anchorPath: root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') {
      return { ok: false, retryable: acquired.state === 'contended', reason: 'Ack ledger is busy.' };
    }
    try {
      // Scan under the ledger lock so pruning cannot race a concurrent ack.
      const live = liveReceipts(inbox);
      if (live === 'retryable') return { ok: false, retryable: true, reason: 'Bus inbox is busy.' };
      if (live === 'unavailable') return { ok: false, retryable: true, reason: 'Bus inbox unavailable.' };
      const target = live.find(row => row.envelope.id === id && reads(row.envelope.to));
      if (!target) return { ok: false, retryable: false, reason: 'No live message with that id for this consumer.' };
      let rows: AckRow[];
      try { rows = readAckLedger(root); } catch { return { ok: false, retryable: false, reason: 'Ack ledger unavailable.' }; }
      const key = ackKey(id, target.envelope.to);
      if (rows.some(row => ackKey(row.id, row.to) === key)) return { ok: true, replayed: true };
      // Keep acks only for messages still retained alive: the ledger stays within
      // the inbox's own bound and an id reused after reclaim is not pre-acked.
      const liveKeys = new Set(live.map(row => ackKey(row.envelope.id, row.envelope.to)));
      const next = rows.filter(row => liveKeys.has(ackKey(row.id, row.to)));
      next.push({ id, to: target.envelope.to });
      writePrivateFileAtomically(paths.pending, paths.file, JSON.stringify({ version: ACK_LEDGER_VERSION, acks: next }), {
        anchorPath: root, label: 'Bus transport ack ledger',
      });
      return { ok: true, replayed: false };
    } catch {
      return { ok: false, retryable: true, reason: 'Ack ledger write failed.' };
    } finally { releaseLocalStoreLock(acquired.lock); }
  }

  async function health(): Promise<TransportHealth> {
    const inspection = inspectBusInbox(inbox);
    if (inspection.source === 'unavailable') return { state: 'down', detail: 'Bus inbox unavailable.' };
    try { readAckLedger(rootOf(inbox)); } catch { return { state: 'down', detail: 'Ack ledger unavailable.' }; }
    const count = inspection.liveCount ?? inspection.retainedCount ?? 0;
    const bytes = inspection.retainedBytes ?? 0;
    if (count >= BUS_INBOX_MAX_MESSAGES * DEGRADED_SHARE || bytes >= BUS_INBOX_MAX_BYTES * DEGRADED_SHARE) {
      return { state: 'degraded', detail: 'Bus inbox is near capacity.' };
    }
    return { state: 'up' };
  }

  return { id: options.id ?? FILE_BUS_TRANSPORT_ID, boundary: 'local', send, poll, ack, health };
}

/**
 * Dead letters as `status` envelopes on the file bus, addressed to
 * {@link BUS_DEAD_LETTER_ADDRESS}; read them with a file transport whose
 * addresses include it. The original envelope is kept when it fits, otherwise
 * only its routing metadata (`envelope: null`, `payloadDropped: true`).
 */
export function createFileDeadLetterSink(options: BusInboxOptions = {}): DeadLetterSink {
  return {
    async put(entry: DeadLetter) {
      const { envelope } = entry;
      const summary = {
        id: envelope.id, from: envelope.from, to: envelope.to, kind: envelope.kind,
        priority: envelope.priority, correlationId: envelope.correlationId,
        reason: entry.reason, deadLetteredAt: entry.deadLetteredAt,
        // Last 50 attempts bound the summary well under the envelope cap.
        attempts: entry.attempts.slice(-50).map(attempt => ({
          attempt: attempt.attempt, transport: attempt.transport, outcome: attempt.outcome,
          ...(attempt.reason === undefined ? {} : { reason: attempt.reason }), at: attempt.at,
        })),
      };
      const letter = (payload: TransportEnvelope['body']): TransportEnvelope => ({
        // Derived, fixed-length id: retrying the same dead letter is a duplicate, not a second row.
        id: `dl-${createHash('sha256').update(envelope.id).digest('hex').slice(0, 40)}`,
        from: 'bus-router', to: BUS_DEAD_LETTER_ADDRESS, kind: 'status', priority: envelope.priority,
        correlationId: envelope.correlationId, ttlMs: BUS_DEAD_LETTER_TTL_MS, body: payload,
      });
      const full = toBusEnvelope(letter({
        deadLetter: summary, payloadDropped: false,
        envelope: { ...envelope } as unknown as TransportEnvelope['body'],
      }));
      const wire = full ?? toBusEnvelope(letter({ deadLetter: summary, payloadDropped: true, envelope: null }));
      if (!wire || localWriteGate()) return { ok: false };
      const post = appendBusInbox(wire, options);
      // A conflict means a dead letter for this message id is already recorded
      // (an earlier run with a different attempt log): the first one stands.
      return { ok: post.status === 'posted' || post.status === 'duplicate' || post.status === 'conflict' };
    },
  };
}
