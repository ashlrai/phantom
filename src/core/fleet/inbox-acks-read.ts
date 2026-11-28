/**
 * The MASON-INBOX.md channel-ack read `phm fleet inbox-acks` reports and the
 * unified inbox's `inbox-acks` source projects — one implementation so the
 * two surfaces can never disagree about which recorded entries still owe an
 * ack. Read-only: bounded tails only, no writes, no sends, no locks.
 *
 * An entry owes an ack while no `queue/inbox-acks.jsonl` row records one
 * (`acked` or `skipped`) and no dated leader reply in MASON-OUTBOX.md or
 * PLAN-LOG.md lands after it — the same states `fleet inbox-acks` prints:
 * `acked`, `skipped`, `pending`, `no-channel`. Only the bounded tail of each
 * journal is read, so coverage is the recent window, never claimed complete.
 */
import { open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inboxAckEntry } from './inbox-ack.js';
import { answeringReplyTimed, inboxEntryMs, noChannelReason, type AckReplyTimed } from './inbox-ack-match.js';
import { readOutboxEntries, replyTime } from './mason-outbox.js';
import { INBOX_CHANNEL_LINE, INBOX_HEADING } from './inbox-channel-line.js';

/** Same bounded tail `phm fleet inbox-acks` reads: 256 KiB of MASON-INBOX.md. */
export const INBOX_ACKS_TAIL_BYTES = 256 * 1024;
/** Largest entry window one read scans — the CLI's own `--limit` bound. */
export const INBOX_ACKS_LIMIT_MAX = 200;
/** Reply journals read deep enough that an entry's answering reply is still in view. */
const REPLIES_LIMIT = 5000;

export type InboxAckRowState = 'acked' | 'skipped' | 'pending' | 'no-channel';

export interface InboxAckReportRow {
  /** The whole raw entry (heading line plus body) — what `--flush` re-acks. */
  raw: string;
  entryId: string;
  channel: string | null;
  /** Entry text after the `[src:… id:…]` marker, or the raw entry when unmarked. */
  text: string;
  state: InboxAckRowState;
  reason?: string;
  /** `plan-log <at>` when a dated leader reply is the ack evidence. */
  ackedBy?: string;
}

export interface InboxAcksRead {
  /** MASON-INBOX.md tail state: 'missing' verified-absent, 'unavailable' unreadable. */
  inbox: 'healthy' | 'missing' | 'unavailable';
  /** Ack-ledger state: 'missing' verified-absent (no ack was ever recorded). */
  ledger: 'healthy' | 'missing' | 'unavailable';
  /** Reply-journal state as `readOutboxEntries` reports it; 'degraded' means
   * an answering reply may sit in an unread part, so 'pending' rows are an
   * upper bound, never a proven owed set. */
  replies: 'healthy' | 'missing' | 'degraded';
  /** Oldest→newest rows over the last `limit` entries of the bounded tail. */
  entries: InboxAckReportRow[];
  malformedLedgerRows: number;
}

export interface InboxAcksReadOptions {
  runsDir?: string;
  /** Entries scanned from the tail's end; clamped to 1..INBOX_ACKS_LIMIT_MAX, default the max. */
  limit?: number;
}

/** Bounded, read-only tail; never expose a partial first line. State-honest:
 * absent is 'missing', any read failure 'unavailable' — never an empty
 * inbox passed off as fact. */
async function readInboxTail(path: string): Promise<{ state: 'healthy' | 'missing' | 'unavailable'; text: string }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', text: '' };
  }
  try {
    const { size } = await handle.stat();
    const offset = Math.max(0, size - INBOX_ACKS_TAIL_BYTES);
    const buffer = Buffer.alloc(size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    return { state: 'healthy', text };
  } catch {
    return { state: 'unavailable', text: '' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Whole entries (heading line plus body), oldest first, split like planner-brief.ts. */
export function splitInboxAckEntries(text: string): string[] {
  const entries: Array<{ heading: string; body: string[] }> = [];
  const lines = text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  for (const line of lines) {
    if (INBOX_HEADING.test(line) || (INBOX_CHANNEL_LINE.test(line) && Number.isFinite(Date.parse(line.split(/\s/, 1)[0]!)))) entries.push({ heading: line, body: [] });
    else if (entries.length) entries[entries.length - 1]!.body.push(line);
  }
  return entries.map(e => [e.heading, ...e.body].join('\n'));
}

/** The recorded ack decisions: first valid row per id wins, same as the ledger readers. */
function readInboxAckLedger(runsDir: string): { state: 'healthy' | 'missing' | 'unavailable'; done: Map<string, { status: string; reason?: string }>; malformed: number } {
  const done = new Map<string, { status: string; reason?: string }>();
  let malformed = 0;
  let text = '';
  try {
    text = readFileSync(join(runsDir, 'queue', 'inbox-acks.jsonl'), 'utf8');
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', done, malformed };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { entryId?: unknown; status?: unknown; reason?: unknown };
      if (typeof row.entryId !== 'string' || typeof row.status !== 'string') { malformed++; continue; }
      if ((row.status === 'acked' || row.status === 'skipped') && !done.has(row.entryId)) {
        done.set(row.entryId, { status: row.status, ...(typeof row.reason === 'string' ? { reason: row.reason } : {}) });
      }
    } catch { malformed++; }
  }
  return { state: 'healthy', done, malformed };
}

/** The per-entry state fold `report` applies — ledger row first, then the
 * channel route, then the answering-reply check; reply instants are resolved
 * once for the whole window. */
export function reportInboxAckRows(raws: readonly string[], done: ReadonlyMap<string, { status: string; reason?: string }>,
  replies: readonly AckReplyTimed[]): InboxAckReportRow[] {
  return raws.map((raw): InboxAckReportRow => {
    const entry = inboxAckEntry(raw, '');
    const hit = done.get(entry.entryId);
    const base = { raw, entryId: entry.entryId, channel: entry.channel, text: entry.text || raw };
    if (hit?.status === 'acked') return { ...base, state: 'acked' };
    if (hit?.status === 'skipped') return { ...base, state: 'skipped', ...(hit.reason ? { reason: hit.reason } : {}) };
    if (!entry.channel) return { ...base, state: 'no-channel', reason: noChannelReason(/^## .*? ET \(([^)]+)\)/.exec(raw)?.[1] ?? null) };
    const reply = answeringReplyTimed(inboxEntryMs(raw), replies);
    if (reply) return { ...base, state: 'acked', ackedBy: `plan-log ${reply.at}` };
    return { ...base, state: 'pending', reason: replies.length ? 'no leader reply after this entry yet' : 'no leader reply found in PLAN-LOG yet' };
  });
}

/**
 * One bounded ack-state read over the newest `limit` MASON-INBOX.md entries:
 * the inbox tail, the ack ledger and both reply journals. Never throws —
 * each store reports its own state so a caller can keep unknown unknown.
 */
export async function readInboxAcks(opts: InboxAcksReadOptions = {}): Promise<InboxAcksRead> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const limit = Number.isSafeInteger(opts.limit) && opts.limit! >= 1
    ? Math.min(opts.limit!, INBOX_ACKS_LIMIT_MAX) : INBOX_ACKS_LIMIT_MAX;
  const tail = await readInboxTail(join(runsDir, 'leader', 'MASON-INBOX.md'));
  // The ledger is read even when the inbox tail is not: `fleet inbox-acks`
  // reports its malformed-row count either way, so the two surfaces stay
  // identical on a missing or unreadable inbox.
  const ledger = readInboxAckLedger(runsDir);
  if (tail.state !== 'healthy') {
    return { inbox: tail.state, ledger: ledger.state, replies: 'missing', entries: [], malformedLedgerRows: ledger.malformed };
  }
  const raws = splitInboxAckEntries(tail.text).slice(-limit);
  const repliesRead = await readOutboxEntries({ runsDir, limit: REPLIES_LIMIT });
  const replies: AckReplyTimed[] = repliesRead.entries.map(reply => ({ ...reply, ms: replyTime(reply.at) }));
  return {
    inbox: 'healthy',
    ledger: ledger.state,
    replies: repliesRead.sourceState,
    entries: reportInboxAckRows(raws, ledger.done, replies),
    malformedLedgerRows: ledger.malformed,
  };
}
