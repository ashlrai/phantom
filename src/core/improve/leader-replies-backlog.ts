/**
 * <runs>/imessage/leader-sent.jsonl leader-reply send ledger →
 * self-improvement backlog items.
 *
 * Every live `sendLeaderReplies` pass — `ashlr imessage replies` and the
 * best-effort call inside `ashlr imessage poll --apply`
 * (src/core/comms/imessage-leader-replies.ts, gated on
 * comms.leaderRepliesSend) — appends one {at, hash, status} row per reply
 * it attempts to this append-only file under imessageStateDir():
 *
 *   { at: <ISO-8601>, hash: <64-hex replyTextHash | 'start'>,
 *     status: 'pending' | 'sent' | 'failed' | 'baseline' }
 *
 * 'pending' is recorded before the transport call and 'sent' or 'failed'
 * right behind it; the first failure breaks the batch so later replies
 * wait. 'baseline' rows are written once when the ledger is created, and
 * the 'start' marker row rides the same shape. Dry-run passes and
 * disabled/unverified-handle/busy states write nothing.
 *
 * Until now the ledger's only reader was readClaimed — the writer's own
 * dedupe scan answering "have we already sent this reply hash" (last
 * status per hash wins; anything but 'failed' claims it, so a 'failed'
 * row re-opens its reply while 'pending', 'sent' and 'baseline' claim
 * forever). `phm imessage replies` prints only the current pass's
 * state — a report someone had to run — so recurring adverse evidence
 * never became work. leaderRepliesBacklogItems carries the ledger into
 * discoverBacklog:
 *
 *  - 'failed' rows recurring inside the window: the iMessage send path
 *    keeps erroring. Each failure also breaks the batch, so while sends
 *    keep failing every later leader reply to Mason waits — the only
 *    signal is a one-off CLI exit code and pass state nobody folds.
 *    The cell states the distinct reply-digest count and the busiest
 *    digest's attempt count honestly: one digest failing every pass is
 *    either a poison reply starving the batch or a transport that
 *    rejects its content — both worth the same investigation.
 *  - orphaned 'pending' rows: a hash whose LAST row in the retained
 *    ledger is 'pending' — no 'sent'/'failed' sibling ever landed —
 *    means the process died or threw between the pending append and
 *    the outcome append. Because readClaimed treats 'pending' as
 *    claimed, that reply is a permanent dead letter: never retried,
 *    never sent, invisible. A pending younger than the staleness bound
 *    may still be in flight and never counts.
 *  - oversize: the file has no rotation and readClaimed reads the FIRST
 *    LEDGER_MAX_BYTES via readPrivateFileCapped, throwing 'ledger
 *    unreadable' past it — every live pass then returns 'error' before
 *    recording anything, so the reply path dies with no new evidence.
 *    The tail bound IS the writer's own read bound, so truncated means
 *    exactly that condition; the retained tail still folds cells as a
 *    stated lower bound.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedgerTail's
 *    bounded no-follow tail at the writer's own read bound; nothing is
 *    written and no lock, process or network is touched. A missing or
 *    unreadable file yields no items; a malformed line is skipped,
 *    never guessed.
 *  - Rows count only under the writer's contract: a parseable ISO `at`,
 *    a hash that is 'start' or the 64-hex replyTextHash shape, and the
 *    closed status vocabulary. Hashes are reply-content fingerprints —
 *    they are counted, never emitted.
 *  - The ledger carries no repository column — it describes this
 *    install's leader-reply machinery — so like the custody, self-tick
 *    and launch-cost feeds, items emit only when the backlog's repo
 *    name is the fleet's own; another repository inherits nothing.
 *  - Recurring means recorded across days: the failed cell emits at
 *    LEADER_REPLIES_MIN_ROWS rows across LEADER_REPLIES_MIN_DAYS
 *    distinct UTC days; the orphan cell emits at
 *    LEADER_REPLIES_MIN_ORPHANS dead letters across
 *    LEADER_REPLIES_MIN_ORPHAN_DAYS distinct UTC days — each orphan is
 *    already a confirmed permanent loss, so two across two days is
 *    recurrence, not the three-attempt bar a transient failure needs.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes the counts are a lower bound — though at this bound
 *    truncation also means the oversize item above.
 *  - Dedup is downstream. The item id hashes the cell identity (kind +
 *    repository — never the counts, hashes or timestamps), so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, and the brief names the writer, its
 *    callers and the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { imessageStateDir } from '../integrations/imessage.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is two kinds plus oversize. */
export const LEADER_REPLIES_BACKLOG_MAX_ITEMS = 4;
const LEADER_REPLIES_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const LEADER_REPLIES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const LEADER_REPLIES_FUTURE_SKEW_MS = 60_000;
/** Adverse rows the failed cell needs inside the window before its recurrence counts. */
export const LEADER_REPLIES_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const LEADER_REPLIES_MIN_DAYS = 2;
/**
 * A 'pending' row younger than this may still be in flight — the send is
 * one transport call and the outcome row lands right behind it. Past it,
 * a hash whose last status is still 'pending' is an orphan: the writer
 * died or threw mid-send and readClaimed now claims the reply forever.
 */
export const LEADER_REPLIES_ORPHAN_STALE_MS = 60 * 60 * 1000;
/** Orphaned dead letters the orphan cell needs — each is already a confirmed permanent loss. */
export const LEADER_REPLIES_MIN_ORPHANS = 2;
/** Distinct UTC days those orphans must span. */
export const LEADER_REPLIES_MIN_ORPHAN_DAYS = 2;
/** The fleet's own repository label: the ledger describes this install's comms, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The ledger filename inside imessageStateDir — the writer's LEDGER_FILE. */
const LEDGER_FILE = 'leader-sent.jsonl';
/**
 * The writer's whole-file read bound: readClaimed reads the FIRST
 * LEDGER_MAX_BYTES via readPrivateFileCapped and throws 'ledger
 * unreadable' past it. Duplicated rather than imported from
 * src/core/comms/imessage-leader-replies.ts so the comms module stays
 * out of this feed's Tier-1 import closure — if the writer's bound
 * moves, move this with it.
 */
export const LEDGER_MAX_BYTES = 1024 * 1024;

const STATUSES = new Set(['pending', 'sent', 'failed', 'baseline']);
type LedgerStatus = 'pending' | 'sent' | 'failed' | 'baseline';
/** The writer's hash shapes: replyTextHash's sha256 hex, or the 'start' ledger-creation marker. */
const HASH_RE = /^[a-f0-9]{64}$/;

export interface LeaderRepliesItemsOptions {
  /** Backlog target in owner/name form; the ledger describes the fleet install only. */
  repo: string;
  /** Ledger override (default: join(imessageStateDir(runsDir), 'leader-sent.jsonl')). */
  journalPath?: string;
  /** Runs dir for the ledger default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LEADER_REPLIES_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window, the orphan staleness bound and oversize (default: now). */
  now?: Date;
}

/** One validated ledger row. */
export interface LeaderReplyRow {
  atMs: number;
  utcDay: string;
  /** The reply-content fingerprint — counted, never emitted. */
  hash: string;
  status: LedgerStatus;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — record() emits exactly {at, hash, status}: a parseable ISO
 * `at`, a 'start' marker or 64-hex replyTextHash, and the closed status
 * vocabulary. Anything else is not a ledger row; extra fields are
 * ignored for forward compatibility.
 */
export function parseLeaderReplyJournalEntry(value: unknown): LeaderReplyRow | null {
  if (!isRecord(value)) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const hash = value['hash'];
  if (typeof hash !== 'string' || (hash !== 'start' && !HASH_RE.test(hash))) return null;
  const status = value['status'];
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  return { atMs, utcDay: utcDayOf(atMs), hash, status: status as LedgerStatus };
}

/**
 * Pure: parse one ledger file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseLeaderReplyJournal(text: string): { rows: LeaderReplyRow[]; invalidRows: number } {
  const rows: LeaderReplyRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseLeaderReplyJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the ledger tail
// ---------------------------------------------------------------------------

export interface LeaderRepliesFold {
  /** In-window on-contract rows — the share/context denominator. */
  rows: number;
  /** In-window 'failed' rows. */
  failedRows: number;
  /** Distinct UTC days the failed rows span. */
  failedDays: Set<string>;
  /** failed digest → its in-window failed-row count (bounded by the tail read). */
  failedHashes: Map<string, number>;
  /** In-window 'sent' rows — replies the transport did deliver. */
  sentRows: number;
  /** In-window 'pending' rows (resolved or not) — context only. */
  pendingRows: number;
  /** In-window 'baseline' rows — context only. */
  baselineRows: number;
  /**
   * Orphaned dead letters inside the window: distinct reply digests
   * whose LAST ledger row is a 'pending' older than the staleness bound —
   * the outcome append never landed and readClaimed claims them forever.
   */
  orphans: number;
  /** Distinct UTC days the orphans' pending rows span. */
  orphanDays: Set<string>;
  firstFailedMs: number | null;
  lastFailedMs: number | null;
  firstOrphanMs: number | null;
  lastOrphanMs: number | null;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** Parsed rows outside the window. */
  outsideWindow: number;
}

/**
 * Pure: fold ledger text into the failed-send and orphaned-pending
 * evidence. Rows outside the window and malformed lines never join a
 * cell; 'sent'/'baseline' rows are the healthy path and count only as
 * context. Orphan resolution is a property of the whole retained
 * ledger, not the window: last-status-per-hash mirrors readClaimed's
 * file-order fold, and only a stale in-window 'pending' last row counts
 * — a still-in-flight send is not yet a dead letter.
 */
export function foldLeaderReplyRows(
  text: string,
  opts: { nowMs: number; windowMs?: number; orphanStaleMs?: number },
): LeaderRepliesFold {
  const parsed = parseLeaderReplyJournal(text);
  const fold: LeaderRepliesFold = {
    rows: 0, failedRows: 0, failedDays: new Set(), failedHashes: new Map(),
    sentRows: 0, pendingRows: 0, baselineRows: 0,
    orphans: 0, orphanDays: new Set(),
    firstFailedMs: null, lastFailedMs: null, firstOrphanMs: null, lastOrphanMs: null,
    invalidRows: parsed.invalidRows, outsideWindow: 0,
  };
  const windowMs = opts.windowMs ?? LEADER_REPLIES_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + LEADER_REPLIES_FUTURE_SKEW_MS;
  const staleMs = opts.orphanStaleMs ?? LEADER_REPLIES_ORPHAN_STALE_MS;

  // Last-status-per-hash over every parsed row — the same fold
  // readClaimed applies, so 'pending' last means claimed forever.
  const last = new Map<string, LeaderReplyRow>();
  for (const row of parsed.rows) last.set(row.hash, row);

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    if (row.status === 'failed') {
      fold.failedRows += 1;
      fold.failedDays.add(row.utcDay);
      fold.failedHashes.set(row.hash, (fold.failedHashes.get(row.hash) ?? 0) + 1);
      fold.firstFailedMs = fold.firstFailedMs === null ? row.atMs : Math.min(fold.firstFailedMs, row.atMs);
      fold.lastFailedMs = fold.lastFailedMs === null ? row.atMs : Math.max(fold.lastFailedMs, row.atMs);
    } else if (row.status === 'sent') {
      fold.sentRows += 1;
    } else if (row.status === 'pending') {
      fold.pendingRows += 1;
    } else {
      fold.baselineRows += 1;
    }
  }

  // Orphans: hashes whose last row is a stale in-window 'pending'. Each
  // counts once — the dead letter is the hash, not the attempt count.
  const seenOrphanHashes = new Set<string>();
  for (const row of last.values()) {
    if (row.status !== 'pending' || row.hash === 'start') continue;
    if (row.atMs < windowStart || row.atMs > until) continue;
    if (opts.nowMs - row.atMs <= staleMs) continue;
    if (seenOrphanHashes.has(row.hash)) continue;
    seenOrphanHashes.add(row.hash);
    fold.orphans += 1;
    fold.orphanDays.add(row.utcDay);
    fold.firstOrphanMs = fold.firstOrphanMs === null ? row.atMs : Math.min(fold.firstOrphanMs, row.atMs);
    fold.lastOrphanMs = fold.lastOrphanMs === null ? row.atMs : Math.max(fold.lastOrphanMs, row.atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface LeaderRepliesCell {
  kind: 'failed-send' | 'orphaned-pending';
  /** In-window adverse rows (failed attempts) or dead letters (orphans). */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window on-contract rows overall — the context denominator. */
  records: number;
  /** failed-send only: distinct reply digests the failures spread across. */
  digests: number | null;
  /** failed-send only: the busiest digest's in-window failed-attempt count. */
  busiestDigestAttempts: number | null;
  /** failed-send only: in-window 'sent' rows — replies the transport did deliver. */
  sentContext: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * Pure: recurring cells — the failed-send cell at the row/day bars, the
 * orphaned-pending cell at the dead-letter/day bars. failed-send sorts
 * first (the broader signal), then orphaned-pending.
 */
export function leaderRepliesCells(fold: LeaderRepliesFold, lowerBound = false): LeaderRepliesCell[] {
  const cells: LeaderRepliesCell[] = [];
  if (fold.failedRows >= LEADER_REPLIES_MIN_ROWS && fold.failedDays.size >= LEADER_REPLIES_MIN_DAYS) {
    let busiest = 0;
    for (const count of fold.failedHashes.values()) busiest = Math.max(busiest, count);
    cells.push({
      kind: 'failed-send',
      rows: fold.failedRows,
      days: [...fold.failedDays].sort(),
      records: fold.rows,
      digests: fold.failedHashes.size,
      busiestDigestAttempts: busiest,
      sentContext: fold.sentRows,
      firstSeen: isoOrNull(fold.firstFailedMs),
      lastSeen: isoOrNull(fold.lastFailedMs),
      lowerBound,
    });
  }
  if (fold.orphans >= LEADER_REPLIES_MIN_ORPHANS && fold.orphanDays.size >= LEADER_REPLIES_MIN_ORPHAN_DAYS) {
    cells.push({
      kind: 'orphaned-pending',
      rows: fold.orphans,
      days: [...fold.orphanDays].sort(),
      records: fold.rows,
      digests: null,
      busiestDigestAttempts: null,
      sentContext: null,
      firstSeen: isoOrNull(fold.firstOrphanMs),
      lastSeen: isoOrNull(fold.lastOrphanMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/imessage/leader-sent.jsonl — imessageStateDir() in src/core/integrations/imessage.ts resolves <runs dir>/imessage (ASHLR_RUNS_DIR wins, then ~/.ashlr-runs). sendLeaderReplies in src/core/comms/imessage-leader-replies.ts appends one {at, hash, status} row per attempted leader reply on every live pass: \'pending\' before the transport call, then \'sent\' or \'failed\' — the first failure breaks the batch so later replies wait; \'baseline\' rows are written once at ledger creation beside the \'start\' marker. Callers: `ashlr imessage replies` and the best-effort call inside `ashlr imessage poll --apply` (src/cli/imessage.ts), gated on comms.leaderRepliesSend — dry-run passes write nothing. Its only reader until this feed was readClaimed, the writer\'s own dedupe scan (last status per hash wins; anything but \'failed\' claims the reply forever) — a point-in-time "have we already sent this" read that never folds a recurrence; `phm imessage replies` prints only the current pass.';

const REPRO = 'Reproduce the fold by reading <runs dir>/imessage/leader-sent.jsonl directly, keeping on-contract rows ({at, hash, status} with a parseable ISO at, a \'start\' or 64-hex hash and the closed status vocabulary) whose `at` lands inside the window, counting \'failed\' rows across distinct UTC days, and flagging reply digests whose LAST row is a \'pending\' older than an hour as orphaned dead letters. The writer and its dedupe/batch gates this repository owns are src/core/comms/imessage-leader-replies.ts; the iMessage transport and its error codes are src/core/integrations/imessage.ts; the outbox reply source is src/core/fleet/mason-outbox.ts.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient transport or host incident the later rows recovered from, the orphans trace to a one-off restart already fixed, comms.leaderRepliesSend was switched off (which writes nothing), or the replies themselves are delivering on the default branch now — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: LeaderRepliesCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: LeaderRepliesCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const WINDOW_DAYS = Math.round(LEADER_REPLIES_WINDOW_MS / 86_400_000);

function failedSendPrompt(cell: LeaderRepliesCell): string {
  const digestBit = cell.digests === null ? '' :
    ` across ${cell.digests} distinct reply digest(s)` +
    (cell.busiestDigestAttempts !== null && cell.busiestDigestAttempts > 1
      ? `, the busiest digest alone accounting for ${cell.busiestDigestAttempts} attempt(s)` : '');
  const sentBit = cell.sentContext === 0
    ? ' No reply recorded a \'sent\' row inside the window — the transport may be failing every attempt, not just some.'
    : cell.sentContext !== null && cell.sentContext > 0
      ? ` ${cell.sentContext} other in-window row(s) recorded 'sent', so the transport works for some replies — a content- or timing-specific failure is plausible.`
      : '';
  return [
    `Phantom's iMessage leader-reply ledger keeps recording failed sends — ${cell.rows} 'failed' row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each 'failed' row is one sendLeaderReplies transport attempt that returned ok:false — the reply stays unclaimed and is retried next pass, and the failure also breaks that pass's batch so queued replies wait behind it.${digestBit}${sentBit}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why leader replies to Mason keep failing to send: read the newest rows' timing against the pass cadence (\`ashlr imessage replies\`, the best-effort call inside \`ashlr imessage poll --apply\`) and check src/core/integrations/imessage.ts's sendIMessage path — AppleScript/Automation permission (-1743 and friends in last-send.json's errorCode), the Messages transport itself, the verified-handle gate, or a reply whose content the transport rejects (the busiest digest's repeated failures point there; reply digests are content hashes and are never emitted). Check whether comms.leaderRepliesSend is enabled and whether \`ashlr imessage doctor\` reports the transport ready. The reply pipeline, its dedupe and its callers are this repository's own; the macOS permission prompt and Mason's account are owner-only — name them rather than working around them.`,
    '',
    `If the window has rolled forward, the failures were a transient transport incident the later rows recovered from, the setting was switched off, or replies are delivering now — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function orphanedPendingPrompt(cell: LeaderRepliesCell): string {
  return [
    `Phantom's iMessage leader-reply ledger keeps orphaning sends mid-flight — ${cell.rows} reply digest(s) whose last recorded row is a stale 'pending' across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each orphan is one reply whose 'pending' append landed but whose 'sent'/'failed' outcome append never did — the process died or threw between the two writes. Because readClaimed's last-status fold treats 'pending' as claimed, that reply is a permanent dead letter: never retried, never sent, and invisible to every report.${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why leader-reply sends keep dying between the pending and outcome appends: the gap contains only \`await send(...)\` — check what can kill or stall the pass there (process exits, deploys, host sleep, an unbounded transport call in src/core/integrations/imessage.ts's sendIMessage, the leader-replies lock holder dying). Each orphan also permanently claims its reply — check whether readClaimed should treat a stale unresolved 'pending' as retryable rather than claimed (src/core/comms/imessage-leader-replies.ts readClaimed + the send loop's record pairing). The send loop, its ledger contract and its callers are this repository's own.`,
    '',
    `If the window has rolled forward, the orphans trace to a one-off host restart already fixed, the stale 'pending' rows were resolved by hand, or no new orphans appear now — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

const TITLES: Record<LeaderRepliesCell['kind'], string> = {
  'failed-send': 'iMessage leader replies keep failing to send',
  'orphaned-pending': 'iMessage leader replies keep orphaning mid-send',
};

const AREAS: Record<LeaderRepliesCell['kind'], string> = {
  'failed-send': 'leader-replies-failed',
  'orphaned-pending': 'leader-replies-orphaned',
};

function leaderRepliesItem(cell: LeaderRepliesCell, repo: string): CloudBacklogItem {
  const id = `leader-replies-${cell.kind}-${createHash('sha256').update(`leader-sent:${repo.trim().toLowerCase()}:${cell.kind}`).digest('hex').slice(0, 16)}`;
  const prompt = cell.kind === 'failed-send' ? failedSendPrompt(cell) : orphanedPendingPrompt(cell);
  return {
    id,
    title: TITLES[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt,
    area: AREAS[cell.kind],
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function oversizePrompt(): string {
  return [
    `Phantom's iMessage leader-reply ledger has outgrown its own read bound — every live sendLeaderReplies pass now returns 'error' before it can send or journal, the self-improvement work this backlog exists for.`,
    '',
    `leader-sent.jsonl is append-only with no rotation: readClaimed reads the FIRST ${LEDGER_MAX_BYTES} bytes via readPrivateFileCapped and throws 'ledger unreadable' once the file passes it, the outer catch converts it to state 'error', and no reply is ever attempted again. The file records this install's leader-reply attempts to Mason — the condition is install-wide, not one repo's evidence.`,
    '',
    EVIDENCE,
    '',
    `Find why the ledger reached its bound and fix the growth or the bound: the writer appends up to four rows per attempted reply (pending + outcome, plus retries of failed digests) with no compaction — check whether readClaimed's dedupe really needs the full history (it keys on hash + last status, so a bounded retention or compacted index may serve it), whether LEDGER_MAX_BYTES in src/core/comms/imessage-leader-replies.ts should rise, or whether the file should rotate like the sibling journals do. The send loop and journal contract are this repository's own.`,
    '',
    `If the file was already truncated or rotated by hand and the newest tail reads clean, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function oversizeItem(repo: string): CloudBacklogItem {
  return {
    id: `leader-replies-oversize-${createHash('sha256').update(`leader-sent-oversize:${repo.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`,
    title: 'iMessage leader-reply ledger exceeded its read bound — every pass errors'.slice(0, MAX_TITLE_CHARS),
    prompt: oversizePrompt(),
    area: 'leader-replies-oversize',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the leader-reply send ledger's recurring adverse
 * evidence plus its oversize condition. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function leaderRepliesBacklogItems(opts: LeaderRepliesItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's comms machinery and carries
    // no repository column — like the custody, self-tick and launch-cost
    // feeds, only the fleet's own repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(imessageStateDir(runsDir), LEDGER_FILE);
    // The tail bound IS the writer's own read bound: truncated means the
    // file passed LEDGER_MAX_BYTES and readClaimed now throws on every
    // pass — the oversize condition — while the retained tail still
    // folds cells as a stated lower bound.
    const read = await readLedgerTail(journalPath, LEDGER_MAX_BYTES);
    if (read.state !== 'read') return [];
    const fold = foldLeaderReplyRows(read.text, { nowMs });
    const cells = leaderRepliesCells(fold, read.truncated);
    const items: CloudBacklogItem[] = [];
    if (read.truncated) items.push(oversizeItem(repo));
    const limit = Math.max(1, Math.min(opts.limit ?? LEADER_REPLIES_BACKLOG_MAX_ITEMS, LEADER_REPLIES_ITEM_HARD_MAX));
    items.push(...cells.slice(0, limit).map((cell) => leaderRepliesItem(cell, repo)));
    return items.slice(0, LEADER_REPLIES_ITEM_HARD_MAX);
  } catch {
    return [];
  }
}
