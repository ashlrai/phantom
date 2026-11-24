/** Claim → bound Slack thread notice sender for the Nov12 22:29/22:30 and
 * Nov13 13:13 ET orders: `planClaimThreadNotices` decides what a claim's
 * source thread needs to hear (ASSIGNED / RELEASED / BLOCKED / VERIFIED),
 * this pass is what actually sends it. The planner is pure; everything
 * stateful or outward lives here.
 *
 * Once-only is durable, not incidental:
 *  - `claim-notice-prev.json` holds the snapshot the next pass diffs
 *    against. It is written ONLY when every planned notice either sent or
 *    was already in the sent ledger, so a failed send re-plans the same
 *    transition next pass instead of being silently dropped.
 *  - `claim-notice-sent.jsonl` is the dedupe fence the planner's header
 *    requires from its caller: a dedupeKey is appended only after the
 *    sender reports a durable outcome, so a retried pass never re-posts,
 *    and a crashed pass can only under-post, never double-post.
 *  - `send` receives the dedupeKey so transports can mint a deterministic
 *    idempotency id (`claim-notice-<hash>`); a send that succeeded while
 *    the ledger append failed is then a transport-level duplicate, not a
 *    second thread reply.
 *
 * An 'unknown' board read writes nothing and sends nothing: an unreadable
 * ledger can never masquerade as a release flood. The ledger stores
 * dedupeKey + timestamp only — never message text, tokens or thread
 * contents. Labels grant no authority. */
import { appendFileSync, chmodSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { planClaimThreadNotices, type ClaimThreadBinding, type ClaimThreadNotice,
  type ClaimThreadSnapshot } from './claim-thread-notice.js';
import type { FleetBoard } from './coordination.js';
import { defaultStatePath } from './main-red-age.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

/** A durable outcome ('posted' or a transport-level duplicate) is `ok`; the
 * dedupeKey is ledgered. Anything else retries next pass. */
export type ClaimNoticeSendOutcome = { ok: true; receipt?: string } | { ok: false; reason?: string };
/** `dedupeKey` is the notice's stable identity: transports that support
 * idempotent ids should derive their send id from it so a retried send of
 * the same logical notice cannot post twice. */
export type ClaimNoticeSend = (threadKey: string, text: string, dedupeKey: string) =>
  ClaimNoticeSendOutcome | Promise<ClaimNoticeSendOutcome>;

export interface ClaimNoticeSendDeps {
  /** One fleet board read; `state !== 'known'` halts the pass. */
  readBoard: () => FleetBoard;
  /** Previous pass's snapshot; `null` (absent/corrupt) is a first pass. */
  readPrevSnapshot: () => ClaimThreadSnapshot | null;
  /** Optional durable read that distinguishes absence from an outage. */
  readPrevSnapshotState?: () => { state: 'absent' | 'unavailable' } | { state: 'available'; snapshot: ClaimThreadSnapshot };
  /** Persist the snapshot for the next diff; called only on a clean pass. */
  writePrevSnapshot: (snapshot: ClaimThreadSnapshot) => void;
  /** claimId+repo → exact source thread bindings. `null` means the durable
   * bindings are unreadable (not merely empty): the pass retains the pending
   * transition instead of planning against an untrusted empty set. */
  readBindings: () => readonly ClaimThreadBinding[] | null;
  /** Delivered dedupeKeys; `null` means the ledger cannot be trusted (refuse). */
  readSentLedger: () => ReadonlySet<string> | null;
  /** Ledger one delivered dedupeKey (timestamped row, no text). */
  appendSentLedger: (dedupeKey: string, at: number) => void;
  /** Persist the first attempt clock BEFORE enqueue, so retries render identical
   * timestamps even when enqueue succeeded but the sent ledger write failed. */
  noticeTime?: (dedupeKey: string, now: number) => number;
  send: ClaimNoticeSend;
  now: () => number;
  /** Plan only: never send, ledger or write the snapshot. */
  dryRun?: boolean;
}

export interface ClaimNoticeDelivery {
  threadKey: string;
  state: ClaimThreadNotice['state'];
  dedupeKey: string;
  /** 'ledgered' was fenced by the sent ledger; 'planned' only appears on dry runs. */
  result: 'sent' | 'ledgered' | 'failed' | 'planned';
  receipt?: string;
  reason?: string;
  text: string;
}

export interface ClaimNoticePassResult {
  status: 'completed' | 'dry-run' | 'board-unavailable' | 'ledger-unavailable' | 'bindings-unavailable' | 'prev-unavailable';
  reason?: string;
  /** True when there was no usable prior 'known' snapshot to diff against. */
  baselined: boolean;
  planned: number;
  sent: number;
  /** Failed notice deliveries or ledger appends, plus a failed snapshot write. */
  failed: number;
  skipped: number;
  deliveries: ClaimNoticeDelivery[];
}

/** One pass: read the board, diff against the stored snapshot, send every
 * planned notice the ledger has not already fenced, then advance the
 * snapshot only when nothing is left pending. */
export async function runClaimNoticePass(deps: ClaimNoticeSendDeps): Promise<ClaimNoticePassResult> {
  const now = deps.now();
  const empty = (status: ClaimNoticePassResult['status'], reason: string): ClaimNoticePassResult =>
    ({ status, reason, baselined: false, planned: 0, sent: 0, failed: 0, skipped: 0, deliveries: [] });
  const board = deps.readBoard();
  if (board.state !== 'known') return empty('board-unavailable', `board-state-${board.state}`);
  const ledger = deps.readSentLedger();
  if (ledger === null) return empty('ledger-unavailable', 'sent-ledger-unreadable');
  const sent = new Set(ledger);
  let prevState: ReturnType<NonNullable<ClaimNoticeSendDeps['readPrevSnapshotState']>> | undefined;
  try { prevState = deps.readPrevSnapshotState?.(); } catch { return empty('prev-unavailable', 'prev-snapshot-unreadable'); }
  if (prevState?.state === 'unavailable') return empty('prev-unavailable', 'prev-snapshot-unreadable');
  const prev: ClaimThreadSnapshot = (prevState ? (prevState.state === 'available' ? prevState.snapshot : null) : deps.readPrevSnapshot())
    ?? { state: 'unknown', claims: [], messages: [], asOf: now };
  const next: ClaimThreadSnapshot = {
    state: 'known', claims: board.claims, messages: board.messages, asOf: now,
  };
  const baselined = prev.state !== 'known';
  // Unreadable bindings must not look like "no bindings": planning against []
  // would drop the transition and then advance prev past it. Halt with prev,
  // ledger and sends untouched so the transition replans after repair.
  let bindings: readonly ClaimThreadBinding[] | null;
  try { bindings = deps.readBindings(); } catch { bindings = null; }
  if (bindings === null) return empty('bindings-unavailable', 'claim-bindings-unreadable');
  let notices = planClaimThreadNotices(prev, next, bindings, now);
  if (!deps.dryRun && deps.noticeTime) {
    const times = new Map<string, number>();
    try {
      for (const notice of notices) {
        if (!sent.has(notice.dedupeKey)) times.set(notice.dedupeKey, deps.noticeTime(notice.dedupeKey, now));
      }
      notices = planClaimThreadNotices(prev, next, bindings, now, times);
    } catch {
      // An unreadable/unwritable attempt clock cannot safely mint a new payload
      // under an id that may already have been enqueued. Keep the delta pending.
      return empty('ledger-unavailable', 'notice-clock-unavailable');
    }
  }
  const delivery = (notice: ClaimThreadNotice, result: ClaimNoticeDelivery['result'],
    extra: Partial<ClaimNoticeDelivery> = {}): ClaimNoticeDelivery =>
    ({ threadKey: notice.threadKey, state: notice.state, dedupeKey: notice.dedupeKey,
      text: notice.text, result, ...extra });
  if (deps.dryRun === true) {
    const deliveries = notices.map(notice =>
      delivery(notice, sent.has(notice.dedupeKey) ? 'ledgered' : 'planned'));
    return { status: 'dry-run', baselined, planned: notices.length, sent: 0, failed: 0,
      skipped: deliveries.filter(d => d.result === 'ledgered').length, deliveries };
  }
  const deliveries: ClaimNoticeDelivery[] = [];
  let failed = 0;
  for (const notice of notices) {
    if (sent.has(notice.dedupeKey)) {
      deliveries.push(delivery(notice, 'ledgered'));
      continue;
    }
    let outcome: ClaimNoticeSendOutcome;
    try {
      outcome = await deps.send(notice.threadKey, notice.text, notice.dedupeKey);
    } catch {
      outcome = { ok: false, reason: 'send-threw' };
    }
    if (outcome.ok !== true) {
      failed++;
      deliveries.push(delivery(notice, 'failed', outcome.reason ? { reason: outcome.reason } : {}));
      continue;
    }
    try {
      deps.appendSentLedger(notice.dedupeKey, now);
    } catch {
      // The deterministic transport id dedupes the retried send next pass.
      failed++;
      deliveries.push(delivery(notice, 'failed', { reason: 'ledger-append-failed' }));
      continue;
    }
    sent.add(notice.dedupeKey);
    deliveries.push(delivery(notice, 'sent', outcome.receipt ? { receipt: outcome.receipt } : {}));
  }
  // Snapshot advances only when every planned notice is durable: a failed
  // send leaves prev unchanged so the transition re-plans next pass, while
  // the ledger fences the ones that did go out. A lost snapshot write only
  // replays the diff — the ledger still stops a second post.
  let reason: string | undefined;
  if (failed === 0) {
    try { deps.writePrevSnapshot(next); } catch { failed++; reason = 'snapshot-write-failed'; }
  }
  return {
    status: 'completed', ...(reason ? { reason } : {}), baselined, planned: notices.length, failed,
    sent: deliveries.filter(d => d.result === 'sent').length,
    skipped: deliveries.filter(d => d.result === 'ledgered').length,
    deliveries,
  };
}

// ---------------------------------------------------------------------------
// File-backed state under the fleet runs root (the same resolver
// runtime-snapshot.ts uses: dirname(dirname(defaultStatePath()))).
// ---------------------------------------------------------------------------

const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
const BINDINGS_MAX_BYTES = 4 * 1024 * 1024;
const PREV_MAX_BYTES = 4 * 1024 * 1024;
export const CLAIM_NOTICE_SENT_MAX_KEYS = 5000;
const SNAPSHOT_MAX_ROWS = 5000;

/** `~/.ashlr-runs` — alongside the other durable fleet state. */
export function claimNoticeDir(runsRoot?: string): string {
  return runsRoot ?? dirname(dirname(defaultStatePath()));
}

export interface ClaimNoticePaths {
  bindings: string;
  sent: string;
  prev: string;
  clocks: string;
}

export function claimNoticePaths(root = claimNoticeDir()): ClaimNoticePaths {
  return {
    bindings: join(root, 'claim-thread-bindings.jsonl'),
    sent: join(root, 'claim-notice-sent.jsonl'),
    prev: join(root, 'claim-notice-prev.json'),
    clocks: join(root, 'claim-notice-clocks.jsonl'),
  };
}

const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The dedupeKey is an opaque planner identity; the ledger never stores
 * text, tokens or thread contents beside it. */
export function appendClaimNoticeSent(sentPath: string, dedupeKey: string, at: number): void {
  if (!bounded(dedupeKey, 4096) || !safeInt(at)) throw new Error('invalid ledger row');
  const dir = dirname(sentPath);
  ensurePrivateDirectory(dir);
  const read = readPrivateFileCapped(sentPath, LEDGER_MAX_BYTES);
  if (read?.truncated) throw new Error('sent ledger truncated');
  const rows = read === null ? [] : read.text.split('\n').filter(line => line.trim().length > 0);
  const row = JSON.stringify({ v: 1, at, key: dedupeKey });
  if (rows.length + 1 > CLAIM_NOTICE_SENT_MAX_KEYS) {
    writePrivateFileAtomic(sentPath,
      `${[...rows.slice(-(CLAIM_NOTICE_SENT_MAX_KEYS - 1)), row].join('\n')}\n`);
    return;
  }
  appendFileSync(sentPath, `${row}\n`, { mode: 0o600 });
  chmodSync(sentPath, 0o600);
}

/** Delivered dedupeKeys; `null` when the ledger exists but cannot be
 * trusted (unreadable, truncated, or any nonblank line that is not a valid v1 record —
 * a torn write, an unsupported version or a malformed key means the file
 * may hide earlier deliveries, so a partial set must never masquerade as
 * complete). A missing ledger is an empty set; the file itself is never
 * repaired, truncated or deleted here — recovery stays with its owner. */
export function readClaimNoticeSentRows(sentPath: string): Array<{ key: string; at: number }> | null {
  const read = readPrivateFileCapped(sentPath, LEDGER_MAX_BYTES);
  if (read === null) {
    try { lstatSync(sentPath); } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    return null;
  }
  if (read.truncated) return null;
  const rows: Array<{ key: string; at: number }> = [];
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { return null; }
    if (!record(row) || row.v !== 1 || !safeInt(row.at) || !bounded(row.key, 4096)) return null;
    rows.push({ key: row.key, at: row.at });
  }
  return rows;
}

export function readClaimNoticeSent(sentPath: string): Set<string> | null {
  const rows = readClaimNoticeSentRows(sentPath);
  return rows === null ? null : new Set(rows.map(row => row.key));
}

/** claimId+repo → thread bindings, last row wins per pair so a corrected
 * binding supersedes rather than colliding. Any invalid nonblank row makes the
 * entire file unavailable; a partial set could lose a pending transition.
 * `null` = the durable file exists but cannot be trusted (over the byte or
 * distinct-row budget, or present yet unopenable: a directory, symlink or
 * unreadable file). A genuinely ABSENT or empty file is a known-empty set
 * (`[]`): nothing was ever bound, so ordinary unbound work is dropped by the
 * planner rather than stranded, and no destination is invented. */
export function readClaimThreadBindingsState(bindingsPath: string): ClaimThreadBinding[] | null {
  const read = readPrivateFileCapped(bindingsPath, BINDINGS_MAX_BYTES);
  if (read === null) {
    try { lstatSync(bindingsPath); } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    return null;
  }
  if (read.truncated) return null;
  const bindings = new Map<string, ClaimThreadBinding>();
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!record(row) || row.v !== 1 || !bounded(row.claimId, 128) || !bounded(row.repo, 256)
        || !bounded(row.threadKey, 256)
        || (row.pr !== undefined && !(Number.isSafeInteger(row.pr) && (row.pr as number) >= 0))
        || (row.head !== undefined && !bounded(row.head, 128))) return null;
      const binding: ClaimThreadBinding = {
        claimId: row.claimId, repo: row.repo, threadKey: row.threadKey,
        ...(row.pr !== undefined ? { pr: row.pr as number } : {}),
        ...(row.head !== undefined ? { head: row.head as string } : {}),
      };
      bindings.set(JSON.stringify([binding.claimId, binding.repo]), binding);
      if (bindings.size > SNAPSHOT_MAX_ROWS) return null;
    } catch { return null; }
  }
  return [...bindings.values()];
}

/** Compatibility reader: unavailable collapses to `[]` (binds nothing). The
 * sender uses {@link readClaimThreadBindingsState} so it can tell the two apart. */
export function readClaimThreadBindings(bindingsPath: string): ClaimThreadBinding[] {
  return readClaimThreadBindingsState(bindingsPath) ?? [];
}

const claimShape = (v: unknown): boolean => record(v)
  && bounded(v.id, 128) && bounded(v.repo, 256) && bounded(v.task, 1024) && bounded(v.agent, 128)
  && safeInt(v.claimedAt) && safeInt(v.expiresAt);
const messageShape = (v: unknown): boolean => record(v)
  && bounded(v.id, 128) && bounded(v.from, 128) && bounded(v.to, 128) && bounded(v.body, 8192)
  && safeInt(v.at) && safeInt(v.expiresAt);

/** Distinguish a genuinely absent snapshot from history that cannot be trusted. */
function readClaimNoticePrevState(prevPath: string): { state: 'absent' | 'unavailable' } | { state: 'available'; snapshot: ClaimThreadSnapshot } {
  const read = readPrivateFileCapped(prevPath, PREV_MAX_BYTES);
  if (read === null) {
    try { lstatSync(prevPath); } catch (error) {
      return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable' };
    }
    return { state: 'unavailable' };
  }
  if (read.truncated) return { state: 'unavailable' };
  try {
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    if (parsed.v !== 1 || (parsed.state !== 'known' && parsed.state !== 'unknown')
      || !Array.isArray(parsed.claims) || parsed.claims.length > SNAPSHOT_MAX_ROWS
      || !parsed.claims.every(claimShape)
      || !Array.isArray(parsed.messages) || parsed.messages.length > SNAPSHOT_MAX_ROWS
      || !parsed.messages.every(messageShape) || !safeInt(parsed.asOf)) return { state: 'unavailable' };
    return { state: 'available', snapshot: {
      state: parsed.state,
      claims: parsed.claims as ClaimThreadSnapshot['claims'],
      messages: parsed.messages as ClaimThreadSnapshot['messages'],
      asOf: parsed.asOf,
    } };
  } catch { return { state: 'unavailable' }; }
}

/** Compatibility reader: absent and unavailable snapshots both return null. */
export function readClaimNoticePrev(prevPath: string): ClaimThreadSnapshot | null {
  const result = readClaimNoticePrevState(prevPath);
  return result.state === 'available' ? result.snapshot : null;
}

/** Persist this pass's snapshot atomically (temp file + rename). */
export function writeClaimNoticePrev(prevPath: string, snapshot: ClaimThreadSnapshot): void {
  ensurePrivateDirectory(dirname(prevPath));
  writePrivateFileAtomic(prevPath, JSON.stringify({ v: 1, ...snapshot }));
}

/** The durable state half of {@link ClaimNoticeSendDeps}; the caller still
 * supplies readBoard, send and now. */
export function claimNoticeFileDeps(root = claimNoticeDir()): Pick<ClaimNoticeSendDeps,
  'readPrevSnapshot' | 'readPrevSnapshotState' | 'writePrevSnapshot' | 'readBindings' | 'readSentLedger' | 'appendSentLedger' | 'noticeTime'> {
  const paths = claimNoticePaths(root);
  return {
    readPrevSnapshot: () => readClaimNoticePrev(paths.prev),
    readPrevSnapshotState: () => readClaimNoticePrevState(paths.prev),
    writePrevSnapshot: snapshot => {
      writeClaimNoticePrev(paths.prev, snapshot);
      // Every notice is now ledgered and the snapshot is durable. Pending
      // clocks may be retired only after that checkpoint, never before it.
      writePrivateFileAtomic(paths.clocks, '');
    },
    readBindings: () => readClaimThreadBindingsState(paths.bindings),
    readSentLedger: () => readClaimNoticeSent(paths.sent),
    appendSentLedger: (dedupeKey, at) => appendClaimNoticeSent(paths.sent, dedupeKey, at),
    noticeTime: (key, at) => {
      // Same bounded, private key+clock format as the sent ledger. No message
      // text or thread content is stored. Never evict a pending retry clock.
      const rows = readClaimNoticeSentRows(paths.clocks);
      if (rows === null || !safeInt(at)) throw new Error('notice clock unavailable');
      const prior = rows.find(row => row.key === key);
      if (prior) {
        if (prior.at > at) throw new Error('notice clock in future');
        return prior.at;
      }
      if (rows.length >= CLAIM_NOTICE_SENT_MAX_KEYS) throw new Error('notice clock capacity');
      appendClaimNoticeSent(paths.clocks, key, at);
      return at;
    },
  };
}
