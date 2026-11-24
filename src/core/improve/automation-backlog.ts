/**
 * Automations firing-journal recurring evidence → self-improvement
 * backlog items.
 *
 * Every firing transition the automations engine journals goes through
 * journalRecord + appendAutomationJournal
 * (src/core/automations/store.ts): intake queues a candidate as 'fired',
 * trimQueue drops queue-overflow firings and settle() drops firings that
 * waited out AUTOMATION_LIMITS.queuedExpiryMs (both 'dropped'), a lane
 * gate refusal that changes a queued firing's reason and every lane-side
 * deferral journal 'deferred', a lane acceptance journals 'dispatched',
 * a for-good lane refusal journals 'refused', a settlement journals
 * 'settled' carrying the firing's end state ('succeeded' or 'failed'),
 * and a leader-review decision journals 'reviewed'. One generation of
 * rotation keeps the previous file beside the live one:
 *
 *   <ashlr home>/automations/firings.jsonl      (live, rotated past 2 MiB)
 *   <ashlr home>/automations/firings.1.jsonl    (the rotated generation)
 *
 * Each row is {at, event, automationId, firingId, dedupeKey, repo,
 * state, lane, sourceUrl, laneRef, laneUrl, reason, spendUsd} — the
 * automation's own audit trail of what its triggers produced and what
 * the lanes did with it.
 *
 * Until now the journal's only reader was readAutomationJournal — the
 * Verse automations API's newest-200 display tail — a point-in-time
 * surface someone had to open, never a recurrence fold. An automation
 * whose lane keeps refusing its firings, whose dispatched work keeps
 * failing, whose queue keeps overflowing or whose candidates keep
 * waiting out gates and limits looked like isolated rows in a display
 * feed, never a pattern, never work.
 *
 * automationBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue the
 * recurring cells exactly like the sibling fleet-evidence feeds beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Each journal file is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process or
 *    network is touched. A missing file is the writer's normal
 *    first-run state; an unreadable one yields no rows while the other
 *    still folds — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: a parseable `at`, the
 *    closed event vocabulary, the automation/firing id patterns, a
 *    bounded dedupeKey, the owner/name repo pattern, the closed firing
 *    state and lane vocabularies, nullable string back-links and a
 *    finite spendUsd. Malformed lines and off-contract rows are
 *    counted, never guessed. The fold then keeps only the adverse
 *    (event, state) pairings — 'refused', 'dropped', 'deferred', and
 *    'settled' rows whose state is 'failed'; 'fired', 'queued',
 *    'deduped', 'dispatched', 'reviewed' and 'settled'-'succeeded' rows
 *    are valid records that simply are not adverse evidence.
 *  - Deferred rows waiting on the two deliberate global holds — KILL
 *    and no-standing-grant, matched verbatim against the writer's own
 *    reason constants — never join a cell: a fleet-wide stop or grant
 *    lapse defers every automation's queue by design and says nothing
 *    about any one automation. Repo-scope grant waits and lane-level
 *    deferrals (the lane's own budget/seat gates) still count.
 *  - Recurring means distinct and across days: an (automationId, kind)
 *    cell emits only when its in-window rows name at least
 *    AUTOMATION_MIN_UNITS distinct dedupeKeys across at least
 *    AUTOMATION_MIN_DAYS distinct UTC days inside the 7-day window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply.
 *    One stuck firing is a bad task (and journals 'deferred' once per
 *    drain pass, so row counts alone would lie); recurrence across
 *    distinct events and days is an automation that keeps producing
 *    work its lane cannot take.
 *  - Repo attribution is exact owner/name, case-insensitive: the
 *    journal's repo field is the firing's target repository and the
 *    fold keeps only rows naming the discovery target — an automation
 *    firing on another repo is that repo's evidence, not this one's.
 *    The machinery the prompts point at (the engine, the lanes, the
 *    store, the scheduler) is this repository's own; dispatchd,
 *    launch.sh and the installed schedules are pinned ops machinery.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (automationId + kind — never the counts or timestamps), so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, dedupeKeys are scrubbed, flattened and capped
 *    before they are quoted, every journal string is scrubbed before it
 *    reaches a prompt, and the brief carries the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { AUTOMATIONS_DIR, AUTOMATIONS_JOURNAL_FILE } from '../automations/store.js';
import {
  AUTOMATION_FIRING_ID_PATTERN,
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LANES,
  AUTOMATION_REPO_PATTERN,
} from '../automations/types.js';
import { KILL_REASON, NO_GRANT_REASON } from '../automations/lanes.js';
import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (automationId, kind) cells are bounded by automation count × 4. */
export const AUTOMATION_BACKLOG_MAX_ITEMS = 8;
const AUTOMATION_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const AUTOMATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const AUTOMATION_FUTURE_SKEW_MS = 60_000;
/** Distinct dedupeKeys a cell needs inside the window before its recurrence counts. */
export const AUTOMATION_MIN_UNITS = 3;
/** Distinct UTC days those keys must span — recurring means recorded across days. */
export const AUTOMATION_MIN_DAYS = 2;
/**
 * Bounded tail per journal file. The writer rotates the live file past
 * 2 MiB into firings.1.jsonl, so each file is at most ~2 MiB under the
 * writer's contract; the 4 MiB bound still folds a contract-violating
 * larger file's newest rows with lower-bound counts.
 */
export const AUTOMATION_TAIL_BYTES = 4 * 1024 * 1024;
/** Journal file names under <ashlr home>/automations/: live plus its one rotated generation. */
const JOURNAL_FILES = [AUTOMATIONS_JOURNAL_FILE, AUTOMATIONS_JOURNAL_FILE.replace(/\.jsonl$/, '.1.jsonl')];
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's dedupe-key bound for quoting: the rendered template output stays well under this. */
const MAX_DEDUPE_CHARS = 200;
/** Example dedupeKeys quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct lane/reason tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;

/** The adverse cell kinds the fold emits; everything else is valid but not evidence. */
export type AutomationJournalKind = 'refused' | 'failed' | 'dropped' | 'deferred';

/** One validated journal row inside (or outside, pre-filter) the evidence window. */
export interface AutomationJournalRow {
  atMs: number;
  utcDay: string;
  automationId: string;
  event: string;
  state: string;
  /** The firing's target repository, owner/name as recorded. */
  repo: string;
  lane: string;
  /** Rendered dedupe key — the event's identity within the automation's retention. */
  dedupeKey: string;
  /** The firing's recorded reason sentence, or null. */
  reason: string | null;
}

export interface AutomationItemsOptions {
  /** Backlog target in owner/name form; cells emit only for rows whose repo names it. */
  repo: string;
  /** Automations directory override (default: <ashlr home>/automations — the writer's own resolution). */
  automationsDir?: string;
  /** Most items one call emits (default AUTOMATION_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default AUTOMATION_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

const JOURNAL_EVENTS = new Set([
  'fired', 'queued', 'deduped', 'dispatched', 'deferred', 'refused', 'dropped', 'settled', 'reviewed',
]);
const FIRING_STATES = new Set([
  'queued', 'dispatching', 'dispatched', 'awaiting-review', 'succeeded', 'failed', 'refused', 'dropped', 'rejected',
]);
const LANES = new Set<string>(AUTOMATION_LANES);

/** The two deliberate global holds whose 'deferred' rows say nothing about any one automation. */
const GLOBAL_HOLD_REASONS = new Set([`Waiting: ${KILL_REASON}`, `Waiting: ${NO_GRANT_REASON}`]);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded no-control text: the writer's identity fields never carry control characters. */
function boundedText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** Nullable string field: absent-as-null or a bounded string; anything else is off-contract. */
function nullableString(value: unknown, max = 2048): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.length <= max);
}

/**
 * Pure: validate one parsed journal line against the writer's record
 * contract — the fields the fold reads plus the identity, vocabulary
 * and pairing requirements journalRecord/AutomationJournalRecord
 * enforce. Anything else is not a journal row.
 */
export function parseAutomationJournalEntry(value: unknown): AutomationJournalRow | null {
  if (!isRecord(value)) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const event = value['event'];
  if (typeof event !== 'string' || !JOURNAL_EVENTS.has(event)) return null;
  const automationId = value['automationId'];
  if (typeof automationId !== 'string' || !AUTOMATION_ID_PATTERN.test(automationId)) return null;
  const firingId = value['firingId'];
  if (!(firingId === null || (typeof firingId === 'string' && AUTOMATION_FIRING_ID_PATTERN.test(firingId)))) return null;
  const dedupeKey = value['dedupeKey'];
  if (!boundedText(dedupeKey, MAX_DEDUPE_CHARS)) return null;
  const repo = value['repo'];
  if (typeof repo !== 'string' || !AUTOMATION_REPO_PATTERN.test(repo)) return null;
  const state = value['state'];
  if (typeof state !== 'string' || !FIRING_STATES.has(state)) return null;
  const lane = value['lane'];
  if (typeof lane !== 'string' || !LANES.has(lane)) return null;
  for (const key of ['sourceUrl', 'laneRef', 'laneUrl'] as const) {
    if (!nullableString(value[key])) return null;
  }
  const reason = value['reason'];
  if (!(reason === null || (typeof reason === 'string' && reason.length <= 4096))) return null;
  const spendUsd = value['spendUsd'];
  if (typeof spendUsd !== 'number' || !Number.isFinite(spendUsd)) return null;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    automationId,
    event,
    state,
    repo,
    lane,
    dedupeKey,
    reason: typeof reason === 'string' ? reason : null,
  };
}

/**
 * Pure: parse one journal file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseAutomationJournal(text: string): { rows: AutomationJournalRow[]; invalidRows: number } {
  const rows: AutomationJournalRow[] = [];
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
    const row = parseAutomationJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

export interface AutomationTally {
  /** Sanitized recorded text (a lane or reason label). */
  text: string;
  count: number;
}

/** One (automationId, kind) cell: distinct events needing attention plus the recorded detail the prompt quotes. */
export interface AutomationCell {
  automationId: string;
  kind: AutomationJournalKind;
  /** Distinct dedupeKeys the journal recorded inside the window. */
  units: number;
  /** In-window journal rows in the cell (one firing can journal 'deferred' every drain pass). */
  rows: number;
  /** Distinct UTC days the rows fall on. */
  days: Set<string>;
  /** Recorded lanes, most frequent first (capped at MAX_PROMPT_TALLIES). */
  lanes: AutomationTally[];
  /** Recorded reasons, most frequent first (capped at MAX_PROMPT_TALLIES). */
  reasons: AutomationTally[];
  /** Up to MAX_EXAMPLES dedupeKeys — the events that keep recurring. */
  examples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): AutomationTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + AUTOMATION_FUTURE_SKEW_MS;

/**
 * The adverse cell a validated row joins, or null. 'settled' rows carry
 * their end state — only 'failed' is adverse ('succeeded' is the
 * writer's deliberate-off vocabulary). 'deferred' rows on the two
 * global hold reasons are deliberate fleet-wide states, never cells.
 */
function cellKindOf(row: AutomationJournalRow): AutomationJournalKind | null {
  switch (row.event) {
    case 'refused':
      return 'refused';
    case 'dropped':
      return 'dropped';
    case 'deferred':
      return row.reason !== null && GLOBAL_HOLD_REASONS.has(row.reason) ? null : 'deferred';
    case 'settled':
      return row.state === 'failed' ? 'failed' : null;
    default:
      return null;
  }
}

/**
 * Pure: fold validated rows into per-(automationId, kind) cells. Rows
 * outside the window and rows whose repo does not name opts.repo
 * (case-insensitive owner/name) never join a cell.
 */
export function foldAutomationCells(
  rows: readonly AutomationJournalRow[],
  opts: { nowMs: number; windowMs?: number; repo: string },
  lowerBound = false,
): AutomationCell[] {
  const windowMs = opts.windowMs ?? AUTOMATION_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const targetRepo = opts.repo.trim().toLowerCase();
  const cells = new Map<string, {
    automationId: string;
    kind: AutomationJournalKind;
    keys: Set<string>;
    rows: number;
    days: Set<string>;
    lanes: Map<string, number>;
    reasons: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const row of rows) {
    if (row.repo.toLowerCase() !== targetRepo) continue;
    if (!inWindow(row.atMs, windowStart, opts.nowMs)) continue;
    const kind = cellKindOf(row);
    if (kind === null) continue;
    const key = JSON.stringify([row.automationId, kind]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        automationId: row.automationId,
        kind,
        keys: new Set(),
        rows: 0,
        days: new Set(),
        lanes: new Map(),
        reasons: new Map(),
        firstMs: null,
        lastMs: null,
      };
      cells.set(key, cell);
    }
    cell.keys.add(row.dedupeKey);
    cell.rows += 1;
    cell.days.add(row.utcDay);
    bump(cell.lanes, row.lane);
    if (row.reason !== null) bump(cell.reasons, fieldText(row.reason, FIELD_MAX) || '(no reason recorded)');
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      automationId: cell.automationId,
      kind: cell.kind,
      units: cell.keys.size,
      rows: cell.rows,
      days: cell.days,
      lanes: tallyOf(cell.lanes, MAX_PROMPT_TALLIES),
      reasons: tallyOf(cell.reasons, MAX_PROMPT_TALLIES),
      examples: [...cell.keys].slice(0, MAX_EXAMPLES).map((key) => fieldText(key, 120)),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.units - a.units || b.rows - a.rows || a.automationId.localeCompare(b.automationId) || a.kind.localeCompare(b.kind));
}

/** The evidence pointers every prompt shares; the write-mostly-journal gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is <ashlr home>/automations/firings.jsonl and its one rotated generation firings.1.jsonl — the writer resolves $ASHLR_HOME or ~/.ashlr per call (ashlrHome in src/core/cloud/store.ts), never a child-process redirect. journalRecord + appendAutomationJournal in src/core/automations/store.ts append one row per firing transition the engine in src/core/automations/engine.ts journals: intake queues (\'fired\'), queue-overflow trims and 7-day expiry drops (\'dropped\'), gate-reason changes and lane deferrals (\'deferred\'), lane acceptances (\'dispatched\'), for-good lane refusals (\'refused\'), settlements (\'settled\' carrying state succeeded/failed) and leader-review decisions (\'reviewed\'). readAutomationJournal feeds only the Verse automations API\'s newest-200 display tail — a point-in-time surface, never a recurrence fold. Until this feed the journal had no trend reader at all.';

const NO_CHANGE = 'If the window has rolled forward, the rows were a one-off burst the lane or queue already absorbed, the waits were deliberate ops states (KILL, grant changes, lane budgets only a person can move, pinned machinery under contrib/mac and ~/.ashlr-runs/bin), or the automation itself was since disabled or retuned — report no-change and name the evidence.';

function tallyText(tallies: readonly AutomationTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: AutomationCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function laneText(cell: AutomationCell): string {
  return cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
}

function reasonText(cell: AutomationCell): string {
  return cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`;
}

function examplesText(cell: AutomationCell): string {
  return cell.examples.length === 0 ? '' : ` Example dedupe keys: ${cell.examples.join(', ')}.`;
}

function boundText(cell: AutomationCell): string {
  return cell.lowerBound ? ' A bounded journal tail was truncated, so these counts are a lower bound.' : '';
}

/** File-level read tallies every prompt states alongside the per-cell bound note. */
interface Coverage {
  invalidRows: number;
  unreadableFiles: number;
}

function coverageNote(coverage: Coverage): string {
  const notes: string[] = [];
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract lines dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} journal file(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function rowNoun(cell: AutomationCell): string {
  return cell.rows === 1 ? 'row' : 'rows';
}

function refusedPrompt(cell: AutomationCell, coverage: Coverage): string {
  return [
    `Phantom's automations keep having firings refused for good — automation '${cell.automationId}' recorded ${cell.units} distinct event(s) across ${cell.rows} refused ${rowNoun(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one firing whose lane refused it terminally — event 'refused', state 'refused' — after the engine dispatched it: the lane said no for good (lane off, repo outside what the lane will take, or the lane's own refusal reason).${laneText(cell)}${reasonText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the lane keeps refusing this automation's work: the automation definitions live in this install's automations state and the lanes in src/core/automations/lanes.ts — check whether the automation's repos, lane choice or trigger scope drifted outside what its lane will accept, whether the lane itself is disabled or missing a grant this repo's policy code should surface earlier, or whether the refusal reason the journal recorded points at a fixable dispatch precondition. The engine, triage, store and scheduler are this repository's own; the lane adapters' host-side state and pinned ops machinery are not.`,
    '',
    `Decide whether the pattern is an automation definition this repo's templates or validation should catch, a lane-policy gap, or correctly-refused work — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

function failedPrompt(cell: AutomationCell, coverage: Coverage): string {
  return [
    `Phantom's automations keep dispatching work that fails — automation '${cell.automationId}' recorded ${cell.units} distinct event(s) across ${cell.rows} failed settlement(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one firing whose lane task ended without landing — event 'settled' carrying state 'failed' — covering lane-reported task failures, launch failures and dispatches interrupted mid-hand-off (the writer's dispatchingStaleMs path, which never re-sends).${laneText(cell)}${reasonText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why this automation's dispatched work keeps failing: join the example dedupe keys to the automation's trigger shape (which repo/events it fires on) and to the fleet's own job outcomes under the runs directory — the laneRef ids the journal rows carry link back to the lane's task record. Check whether the failures cluster on one lane's capacity or output contract, on a trigger that keeps minting unworkable events (issues already fixed, checks already green), on a playbook the automation names that no longer fits, or on lane-side state only a person can clear. The engine, lanes, triage and store are this repository's own; pinned ops machinery and host-side lane state are not.`,
    '',
    `Decide whether the pattern is a trigger or playbook this repo owns that should be retuned, a lane contract gap, or legitimately failing work — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

function droppedPrompt(cell: AutomationCell, coverage: Coverage): string {
  return [
    `Phantom's automations keep dropping queued firings — automation '${cell.automationId}' recorded ${cell.units} distinct event(s) across ${cell.rows} dropped ${rowNoun(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one firing the engine dropped: either the automation's queue overflowed (queueDepth cap, reason 'Dropped: this automation's queue is full') or the firing waited out the 7-day queued expiry behind gates and limits (reason 'Dropped after waiting 7 days').${laneText(cell)}${reasonText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find whether the drops are undersized queues or starved dispatch: the queue-depth trim and the expiry settle live in src/core/automations/engine.ts, the per-automation limits (maxConcurrent, maxPerDay, queueDepth, spendCapUsd) in types.ts and the lane gates in lanes.ts. Check whether the automation's trigger fires faster than its lane drains, whether its limits are set below its event rate, whether firings kept deferring on lane budgets until they expired, or whether the dedupe retention lets the same events re-fire into a queue that never drains. The engine, scheduler and store are this repository's own; pinned ops machinery is not.`,
    '',
    `Decide whether the pattern is a limit or queue-depth default this repo should retune, a lane capacity problem, or events that legitimately should drop — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

function deferredPrompt(cell: AutomationCell, coverage: Coverage): string {
  return [
    `Phantom's automations keep waiting on gates and limits — automation '${cell.automationId}' recorded ${cell.units} distinct event(s) across ${cell.rows} deferred ${rowNoun(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one firing held in 'queued' state: either a lane-gate refusal that changed the firing's reason (repo outside the standing grant's current stage) or a lane-side deferral outcome (the lane's own budget/seat gate). Rows waiting on the two deliberate global holds — KILL and no-standing-grant — are excluded: a fleet-wide stop defers every automation by design and is not this automation's evidence. Note a single queued firing journals 'deferred' on every drain pass, so the distinct-event count is the recurrence signal, not the row count.${laneText(cell)}${reasonText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find what keeps holding this automation's queue: the gate order and reason strings live in src/core/automations/lanes.ts (laneGateRefusal, KILL_REASON, NO_GRANT_REASON) and engine.ts (drainAutomation, updateQueuedReason), the lane adapters' own deferral reasons in the lane outcomes. Check whether the recorded reasons cluster on one gate — a repo that fell out of the grant's stage, a lane budget that never recovers, a per-day or spend cap set below the trigger's rate — or whether the automation's repo list and the standing grant's stage have drifted apart. The engine, lanes, triage and store are this repository's own; grant contents, billing and pinned ops machinery are not.`,
    '',
    `Decide whether the pattern is an automation definition or repo list this repo's validation should catch, a lane-capacity problem, or correctly-held work — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

const TITLES: Record<AutomationJournalKind, (id: string) => string> = {
  refused: (id) => `Automation ${id} keeps having firings refused for good`,
  failed: (id) => `Automation ${id} keeps dispatching firings that fail`,
  dropped: (id) => `Automation ${id} keeps dropping queued firings`,
  deferred: (id) => `Automation ${id} keeps waiting on gates and limits`,
};

const PROMPTS: Record<AutomationJournalKind, (cell: AutomationCell, coverage: Coverage) => string> = {
  refused: refusedPrompt,
  failed: failedPrompt,
  dropped: droppedPrompt,
  deferred: deferredPrompt,
};

function automationItem(cell: AutomationCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const id = `automation-${cell.kind}-${createHash('sha256').update(`automation-firings:${cell.automationId}:${cell.kind}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: TITLES[cell.kind](cell.automationId).slice(0, MAX_TITLE_CHARS),
    prompt: PROMPTS[cell.kind](cell, coverage),
    area: 'automations',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the automations firing journal's recurring
 * (automationId, kind) cells. Total: any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function automationBacklogItems(opts: AutomationItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const dir = typeof opts.automationsDir === 'string' && opts.automationsDir !== ''
      ? opts.automationsDir
      : join(ashlrHome(), AUTOMATIONS_DIR);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AUTOMATION_WINDOW_MS;

    // Both journal generations are read unconditionally — a missing one
    // is the writer's normal state (fresh install, or no rotation yet).
    const reads = await Promise.all(JOURNAL_FILES.map((name) => readLedgerTail(join(dir, name), AUTOMATION_TAIL_BYTES)));
    const rows: AutomationJournalRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    for (const read of reads) {
      if (read.state !== 'read') {
        // A file that vanished between stat and open is a non-event;
        // anything else unreadable is stated, never guessed.
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      if (read.truncated) truncatedFiles += 1;
      const parsed = parseAutomationJournal(read.text);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    }
    if (rows.length === 0) return [];

    const lowerBound = truncatedFiles > 0;
    const folded = foldAutomationCells(rows, { nowMs, windowMs, repo }, lowerBound);
    const recurring = folded.filter(
      (cell) => cell.units >= AUTOMATION_MIN_UNITS && cell.days.size >= AUTOMATION_MIN_DAYS,
    );
    if (recurring.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? AUTOMATION_BACKLOG_MAX_ITEMS, AUTOMATION_ITEM_HARD_MAX));
    const coverage: Coverage = { invalidRows, unreadableFiles };
    return recurring.slice(0, limit).map((cell) => automationItem(cell, repo, coverage));
  } catch {
    return [];
  }
}
