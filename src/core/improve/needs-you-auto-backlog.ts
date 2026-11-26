/**
 * <runs>/needs-you-auto.jsonl needs-you auto-resolve audit →
 * self-improvement backlog items.
 *
 * Every non-dry-run `resolveAutoNeedsYou` pass — `phm needs-you resolve
 * --auto` (src/cli/needs-you.ts) and the web API's needs-you resolve
 * route (src/core/web/api.ts), the documented way the fleet clears the
 * auto class of the NEEDS-MASON.md ledger — appends one audit record per
 * auto item it attempts to this append-only file directly under the runs
 * dir (ASHLR_RUNS_DIR wins, then ~/.ashlr-runs):
 *
 *   { item: { id: <nm- ledger id>, title: <bounded scrubbed words> },
 *     action: <the forward action taken>, at: <ISO-8601>,
 *     reason: <the classifyNeedsYou verdict reason>,
 *     result?: 'resolved' | 'failed',
 *     error?: <bounded scrubbed resolve error, 'failed' rows only> }
 *
 * A resolved attempt journals the bare record — `result` stays absent
 * (every row written before failures were journaled reads the same
 * way); a failed attempt — resolveNeedsMason answering !ok with a code
 * other than 'already-resolved', or the resolve call itself throwing —
 * journals the same record marked result:'failed' with a bounded,
 * secret-scrubbed error. The writer's own comment states the intent:
 * the audit file is the only durable record of auto attempts, where
 * the report's failed list evaporates with the pass.
 *
 * Until now the ledger's only readers were readNeedsYouAudit's
 * point-in-time folds — the web API's newest-50 audit tail and
 * `phm needs-you log` — surfaces someone had to open, so a resolve
 * path that kept failing never became work: every failed row is one
 * auto item that stayed on the NEEDS-MASON ledger unresolved, still
 * reachable by `phm needs-you` and still owed its forward action.
 * needsYouAutoBacklogItems carries the ledger into discoverBacklog:
 *
 *  - 'failed' rows recurring inside the window: the auto-resolve path
 *    keeps erroring — the bus/leader resolve seam refusing, the
 *    needs-mason ledger write failing, or one poison item whose
 *    resolve throws every pass. The cell states the distinct
 *    failed-item count and the busiest item's attempt count honestly:
 *    failures spread across items point at the resolve machinery,
 *    failures concentrated on one item point at that item — both
 *    worth the same investigation.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedgerTail's
 *    bounded no-follow tail at the writer's own retained bound; nothing
 *    is written and no lock, process or network is touched. A missing
 *    or unreadable file yields no items; a malformed line is skipped,
 *    never guessed.
 *  - Rows count only under the writer's contract: a record object with
 *    item{id,title} strings, action and reason strings, a parseable
 *    ISO `at`, result absent/'resolved'/'failed', and error a string
 *    when present. Item ids and titles, action/reason text and error
 *    text are ledger content — they are counted, never emitted.
 *  - The ledger carries no repository column — it describes this
 *    install's needs-you machinery — so like the custody, self-tick,
 *    launch-cost and leader-replies feeds, items emit only when the
 *    backlog's repo name is the fleet's own; another repository
 *    inherits nothing.
 *  - Recurring means recorded across days: the failed cell emits at
 *    NEEDS_YOU_AUTO_MIN_ROWS failed rows across
 *    NEEDS_YOU_AUTO_MIN_DAYS distinct UTC days — the same bars the
 *    sibling journals use, since each row is one real failed resolve
 *    attempt, not a sampled signal.
 *  - Truncation is stated, never hidden: the writer retains only the
 *    newest AUDIT_READ_MAX bytes of the file, so when the bounded tail
 *    cut older bytes the counts are a stated lower bound. Unlike the
 *    leader-sent ledger this file has no read bound that fails closed —
 *    readNeedsYouAudit slices the same tail out of a full read — so
 *    oversize is context, never an item of its own.
 *  - Dedup is downstream. The item id hashes the cell identity (kind +
 *    repository — never the counts, item ids or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
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
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is one kind. */
export const NEEDS_YOU_AUTO_BACKLOG_MAX_ITEMS = 2;
const NEEDS_YOU_AUTO_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const NEEDS_YOU_AUTO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const NEEDS_YOU_AUTO_FUTURE_SKEW_MS = 60_000;
/** Adverse rows the failed cell needs inside the window before its recurrence counts. */
export const NEEDS_YOU_AUTO_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const NEEDS_YOU_AUTO_MIN_DAYS = 2;
/** The fleet's own repository label: the ledger describes this install's needs-you machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/**
 * The ledger filename and the writer's retained tail bound, duplicated
 * rather than imported from src/core/needs-you/index.ts so the
 * needs-you module stays out of this feed's Tier-1 import closure —
 * NEEDS_YOU_AUDIT_FILE is 'needs-you-auto.jsonl' and AUDIT_READ_MAX is
 * 256 * 1024 there; if either moves, move these with it.
 */
const AUDIT_FILE = 'needs-you-auto.jsonl';
export const NEEDS_YOU_AUTO_READ_MAX = 256 * 1024;

export interface NeedsYouAutoItemsOptions {
  /** Backlog target in owner/name form; the ledger describes the fleet install only. */
  repo: string;
  /** Ledger override (default: join(runsDir, 'needs-you-auto.jsonl')). */
  journalPath?: string;
  /** Runs dir for the ledger default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default NEEDS_YOU_AUTO_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated audit row — ledger content fields are checked for contract, never carried. */
export interface NeedsYouAutoRow {
  atMs: number;
  utcDay: string;
  /** True on result:'failed' rows — the resolve attempt did not resolve. */
  failed: boolean;
  /** The nm- ledger id of the item the attempt targeted — counted, never emitted. */
  itemId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: validate one parsed audit line against the writer's record
 * contract — resolveAutoNeedsYou's isRecord accepts exactly {item:{id,
 * title}, action, at, reason, result?, error?}: item id and title
 * strings, action and reason strings, a parseable ISO `at`, result
 * absent/'resolved'/'failed', error a string when present. Anything
 * else is not an audit row; extra fields are ignored for forward
 * compatibility.
 */
export function parseNeedsYouAutoJournalEntry(value: unknown): NeedsYouAutoRow | null {
  if (!isRecord(value)) return null;
  const item = value['item'];
  if (!isRecord(item)) return null;
  const itemId = item['id'];
  const itemTitle = item['title'];
  if (typeof itemId !== 'string' || typeof itemTitle !== 'string') return null;
  if (typeof value['action'] !== 'string' || typeof value['reason'] !== 'string') return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const result = value['result'];
  if (result !== undefined && result !== 'resolved' && result !== 'failed') return null;
  if (value['error'] !== undefined && typeof value['error'] !== 'string') return null;
  return { atMs, utcDay: utcDayOf(atMs), failed: result === 'failed', itemId };
}

/**
 * Pure: parse one audit file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseNeedsYouAutoJournal(text: string): { rows: NeedsYouAutoRow[]; invalidRows: number } {
  const rows: NeedsYouAutoRow[] = [];
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
    const row = parseNeedsYouAutoJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the audit tail
// ---------------------------------------------------------------------------

export interface NeedsYouAutoFold {
  /** In-window on-contract rows — the share/context denominator. */
  rows: number;
  /** In-window 'failed' rows — auto items the resolve left unresolved. */
  failedRows: number;
  /** Distinct UTC days the failed rows span. */
  failedDays: Set<string>;
  /** Distinct ledger item ids the failed rows targeted. */
  failedItems: Set<string>;
  /** failed item id → its in-window failed-row count (bounded by the tail read). */
  failedItemAttempts: Map<string, number>;
  /** In-window resolved rows — attempts that did resolve (result absent or 'resolved'). */
  resolvedRows: number;
  firstFailedMs: number | null;
  lastFailedMs: number | null;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** Parsed rows outside the window. */
  outsideWindow: number;
}

/**
 * Pure: fold audit text into the failed-resolve evidence. Rows outside
 * the window and malformed lines never join a cell; resolved rows are
 * the healthy path and count only as context.
 */
export function foldNeedsYouAutoRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): NeedsYouAutoFold {
  const parsed = parseNeedsYouAutoJournal(text);
  const fold: NeedsYouAutoFold = {
    rows: 0, failedRows: 0, failedDays: new Set(), failedItems: new Set(),
    failedItemAttempts: new Map(), resolvedRows: 0,
    firstFailedMs: null, lastFailedMs: null,
    invalidRows: parsed.invalidRows, outsideWindow: 0,
  };
  const windowMs = opts.windowMs ?? NEEDS_YOU_AUTO_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + NEEDS_YOU_AUTO_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    if (!row.failed) { fold.resolvedRows += 1; continue; }
    fold.failedRows += 1;
    fold.failedDays.add(row.utcDay);
    fold.failedItems.add(row.itemId);
    fold.failedItemAttempts.set(row.itemId, (fold.failedItemAttempts.get(row.itemId) ?? 0) + 1);
    fold.firstFailedMs = fold.firstFailedMs === null ? row.atMs : Math.min(fold.firstFailedMs, row.atMs);
    fold.lastFailedMs = fold.lastFailedMs === null ? row.atMs : Math.max(fold.lastFailedMs, row.atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface NeedsYouAutoCell {
  kind: 'failed-auto-resolve';
  /** In-window failed rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window on-contract rows overall — the context denominator. */
  records: number;
  /** Distinct ledger items the failures spread across. */
  items: number;
  /** The busiest item's in-window failed-attempt count. */
  busiestItemAttempts: number;
  /** In-window resolved rows — attempts that did resolve. */
  resolvedContext: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * Pure: the recurring failed-auto-resolve cell — failed rows at the
 * row/day bars. It sorts first (and only).
 */
export function needsYouAutoCells(fold: NeedsYouAutoFold, lowerBound = false): NeedsYouAutoCell[] {
  const cells: NeedsYouAutoCell[] = [];
  if (fold.failedRows >= NEEDS_YOU_AUTO_MIN_ROWS && fold.failedDays.size >= NEEDS_YOU_AUTO_MIN_DAYS) {
    let busiest = 0;
    for (const count of fold.failedItemAttempts.values()) busiest = Math.max(busiest, count);
    cells.push({
      kind: 'failed-auto-resolve',
      rows: fold.failedRows,
      days: [...fold.failedDays].sort(),
      records: fold.rows,
      items: fold.failedItems.size,
      busiestItemAttempts: busiest,
      resolvedContext: fold.resolvedRows,
      firstSeen: isoOrNull(fold.firstFailedMs),
      lastSeen: isoOrNull(fold.lastFailedMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/needs-you-auto.jsonl — directly under the runs dir, which ASHLR_RUNS_DIR overrides and ~/.ashlr-runs defaults. resolveAutoNeedsYou in src/core/needs-you/index.ts appends one audit record per auto item per non-dry-run pass: the bare {item, action, at, reason} record when the resolve lands (result absent — every pre-failure row reads the same), or the same record marked result:\'failed\' with a bounded secret-scrubbed error when resolveNeedsMason answers !ok for a code other than \'already-resolved\' or the call throws. Callers: `phm needs-you resolve --auto` (src/cli/needs-you.ts) and the needs-you resolve route in src/core/web/api.ts — the documented fleet path for clearing the auto class of the NEEDS-MASON.md ledger; dry runs write nothing. Its only readers until this feed were readNeedsYouAudit\'s point-in-time folds — the web API\'s newest-50 audit tail and `phm needs-you log`.';

const REPRO = 'Reproduce the fold by reading <runs dir>/needs-you-auto.jsonl directly, keeping on-contract records ({item:{id,title}, action, at, reason} with a parseable ISO at and result absent/\'resolved\'/\'failed\') whose `at` lands inside the window, and counting result:\'failed\' rows across distinct UTC days and distinct item.id values. The writer and its resolve/failure journaling are src/core/needs-you/index.ts (resolveAutoNeedsYou); the resolve path is resolveNeedsMason in src/core/fleet/needs-mason-resolve.ts over the NEEDS-MASON.md ledger; the classifier is classifyNeedsYou in src/core/needs-you/classify.ts.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient bus or ledger outage the later rows recovered from, `resolve --auto` was not being run (an empty or stale journal is not evidence of health — it is absence of attempts), or auto items are resolving on the default branch now — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: NeedsYouAutoCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: NeedsYouAutoCell): string =>
  cell.lowerBound ? ' The writer retains only the newest 256 KiB of the file, so these counts cover only the retained tail — a lower bound, not the full window.' : '';

const WINDOW_DAYS = Math.round(NEEDS_YOU_AUTO_WINDOW_MS / 86_400_000);

function failedAutoResolvePrompt(cell: NeedsYouAutoCell): string {
  const itemBit = ` across ${cell.items} distinct ledger item(s)` +
    (cell.busiestItemAttempts > 1
      ? `, the busiest item alone accounting for ${cell.busiestItemAttempts} failed attempt(s)` : '');
  const resolvedBit = cell.resolvedContext === 0
    ? ' No in-window row resolved — every auto attempt inside the window failed, so the resolve path may be down entirely rather than failing selectively.'
    : cell.resolvedContext > 0
      ? ` ${cell.resolvedContext} other in-window row(s) resolved, so the path works for some items — a content- or item-specific failure is plausible.`
      : '';
  return [
    `Phantom's needs-you auto-resolve audit keeps recording failed attempts — ${cell.rows} result:'failed' row(s)${itemBit} across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each failed row is one auto item resolveAutoNeedsYou could not resolve — the item stays open on the NEEDS-MASON ledger, keeps surfacing in \`phm needs-you\` and \`phm needs-you batch\`, and keeps its forward action owed. Every pass retries every still-open auto item, so a broken resolve path or a poison item produces a fresh failed row each run.${resolvedBit}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why auto-resolves keep failing: read the newest rows' \`error\` values (bounded and secret-scrubbed, never emitted here) against resolveNeedsMason's failure codes in src/core/fleet/needs-mason-resolve.ts — a bus transport refusal, a needs-mason ledger write failure, or an item whose reply the resolver rejects. Check whether the failures concentrate on one item id (a poison item starves nothing but itself, yet never clears) or spread across items (the shared resolve machinery is broken). The needs-you classifier, the audit writer and the resolve seam are this repository's own; the bus transport and any owner-gated ledger state are owner-only — name them rather than working around them.`,
    '',
    `If the window has rolled forward, the failures were a transient outage the later rows recovered from, \`resolve --auto\` stopped being run so no new attempts journaled, or auto items are resolving now — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function needsYouAutoItem(cell: NeedsYouAutoCell, repo: string): CloudBacklogItem {
  const id = `needs-you-auto-${cell.kind}-${createHash('sha256').update(`needs-you-auto:${repo.trim().toLowerCase()}:${cell.kind}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: 'Needs-you auto-resolve keeps failing'.slice(0, MAX_TITLE_CHARS),
    prompt: failedAutoResolvePrompt(cell),
    area: 'needs-you-auto-failed',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the needs-you auto-resolve audit's recurring
 * adverse evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function needsYouAutoBacklogItems(opts: NeedsYouAutoItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's needs-you machinery and
    // carries no repository column — like the custody, self-tick,
    // launch-cost and leader-replies feeds, only the fleet's own
    // repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, AUDIT_FILE);
    // The tail bound IS the writer's own retained bound: truncated
    // means the file passed AUDIT_READ_MAX and readNeedsYouAudit now
    // sees only the newest slice — stated as a lower bound, never an
    // item, since the writer tolerates any size.
    const read = await readLedgerTail(journalPath, NEEDS_YOU_AUTO_READ_MAX);
    if (read.state !== 'read') return [];
    const fold = foldNeedsYouAutoRows(read.text, { nowMs });
    const cells = needsYouAutoCells(fold, read.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? NEEDS_YOU_AUTO_BACKLOG_MAX_ITEMS, NEEDS_YOU_AUTO_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => needsYouAutoItem(cell, repo)).slice(0, NEEDS_YOU_AUTO_ITEM_HARD_MAX);
  } catch {
    return [];
  }
}
