/**
 * Eng Ops autofix ledger evidence → self-improvement backlog items.
 *
 * `phm autofix` is the auto-fix side of the Eng Ops self-aware loop
 * (docs/AUTOFIX.md): each tick reads the INCIDENT-<key>.md filenames
 * self_aware.py writes under <runs>/bus/core/ and appends two ledgers
 * under <runs>/ledger/:
 *
 *   autofix.jsonl    one LedgerLine per non-'skipped' action outcome —
 *                    {ts, fixer, target, action, before, after, result}
 *                    with result in applied | dry-run | skipped |
 *                    refused | refused_admitted | refused_stale |
 *                    refused_operator | failed | detect-only
 *                    (src/core/autofix/run.ts → guard.ts appendLedger)
 *   incidents.jsonl  one IncidentStatusLine per incident outcome
 *                    transition — {key, status, reason, ts} with status
 *                    in fixed | failed | intentional | refused
 *                    (run.ts record → incidents.ts formatIncidentLine)
 *
 * The ledgers' only readers are the pass itself: readLedger feeds
 * alreadyRecorded's idempotency dedup and readIncidentStatuses feeds
 * terminalIncident/previousSame's transition dedup, while
 * `phm autofix --json` prints just the current pass. No report or fold
 * ever reads the history, so a fixer whose actions keep failing, a
 * refusal guard whose precondition never becomes satisfiable, pinned
 * files that keep being hand-edited, and incident classes that keep
 * ending failed or refused were write-only audit — never work.
 *
 * autofixBacklogItems carries both ledgers into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue the
 * recurring cells exactly like the sibling fleet-evidence feeds beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Each ledger is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process or
 *    network is touched. A missing file is the writer's normal
 *    first-run state — a fresh install whose Eng Ops ticks never filed
 *    an incident is clean, not degraded; an unreadable one is counted
 *    in the prompt's coverage note while the other still folds, and a
 *    truncated tail folds the retained rows flagged as a lower bound.
 *  - Rows count only under the writer's contract. Action rows need a
 *    parseable ts, the closed fixer vocabulary (FIXER_IDS plus
 *    'pinned-hand-edit'), bounded target/action strings and the closed
 *    result vocabulary; before/after stay unread — the fold never
 *    quotes them. Incident rows need an INCIDENT_KEY_RE key, the closed
 *    status vocabulary, a string reason and a parseable ts. Malformed
 *    lines are counted, never guessed.
 *  - Only adverse results join action cells: 'failed' (the command or
 *    lane restart threw), 'refused' and its named variants
 *    'refused_admitted' (resident admission kept a needed launchd
 *    disable), 'refused_stale' (crashloop evidence never freshened) and
 *    'detect-only' (pinned-file hand edits and autorun holds filed for
 *    Security). 'applied', 'dry-run' (the default mode's intent rows),
 *    'skipped' (never appended anyway) and 'refused_operator' (the
 *    deliberate 15-minute operator-quiet deferral) are valid records
 *    that are not adverse evidence.
 *  - Recurring means recorded and persistent. An action cell emits only
 *    at AUTOFIX_MIN_ROWS adverse rows across AUTOFIX_MIN_DAYS distinct
 *    UTC days inside the 7-day window — 'failed' is non-terminal in the
 *    writer's dedup so one broken action appends a fresh row every pass,
 *    and that persistent single-target failure is exactly the signal;
 *    terminal refusals re-record only when their before-state drifts,
 *    so their rows already imply fresh evidence. An incident cell emits
 *    only at AUTOFIX_MIN_INCIDENTS distinct keys across
 *    AUTOFIX_MIN_DAYS distinct UTC days — the fleet's RECURRING_FAILURES
 *    convention the sibling feeds apply, since one incident's
 *    transition-deduped rows cannot show recurrence alone.
 *  - Incident class comes from the writer's own parser: the key's
 *    prefix maps through INCIDENT_FIXER_TABLE (a→release-stuck-draft,
 *    b→launchd-crashloop, d→stuck-lane, e→outside-load, g→autorun-hold)
 *    and anything else is 'unknown-prefix' — the same classification
 *    run.ts applies, never a re-guess.
 *  - The journals describe this install's machinery and carry no
 *    repository column, so items emit only when the backlog target's
 *    repository name is 'phantom' — the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids hash the cell identity (never the
 *    counts or timestamps), so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a cell that recovers
 *    simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, targets and incident keys are scrubbed, flattened
 *    and capped before they are quoted, ledger strings are scrubbed,
 *    and the brief carries the usual no-change escape naming the
 *    pinned/owner-side causes.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ledgerPath } from '../autofix/guard.js';
import {
  INCIDENT_KEY_RE,
  incidentsLedgerPath,
  parseIncidentFilename,
} from '../autofix/incidents.js';
import { FIXER_IDS } from '../autofix/types.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by fixer×action and incident-class diversity. */
export const AUTOFIX_BACKLOG_MAX_ITEMS = 8;
const AUTOFIX_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const AUTOFIX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const AUTOFIX_FUTURE_SKEW_MS = 60_000;
/** Adverse action rows a (fixer, action, result) cell needs inside the window. */
export const AUTOFIX_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const AUTOFIX_MIN_DAYS = 2;
/** Distinct incident keys an incident-class cell needs inside the window. */
export const AUTOFIX_MIN_INCIDENTS = 3;
/**
 * Bounded tail per ledger. Rows run a few hundred bytes (before/after are
 * small recorded objects), so 512 KiB covers well over a thousand rows —
 * far past a week of Eng Ops ticks; a contract-violating larger file
 * still folds its newest rows flagged as a lower bound.
 */
export const AUTOFIX_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Example targets/keys quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct result/reason tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** The fleet's own repository label: autofix evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

/** The writer's closed result vocabulary (FixResult in src/core/autofix/types.ts). */
const RESULT_VOCABULARY = new Set([
  'applied', 'dry-run', 'skipped', 'refused', 'refused_admitted',
  'refused_stale', 'refused_operator', 'failed', 'detect-only',
]);
/** Results that are adverse evidence; the rest are valid records that never join a cell. */
const ADVERSE_ACTION_RESULTS = ['failed', 'refused', 'refused_admitted', 'refused_stale', 'detect-only'] as const;
export type AutofixAdverseResult = (typeof ADVERSE_ACTION_RESULTS)[number];
const ADVERSE_RESULT_SET: ReadonlySet<string> = new Set(ADVERSE_ACTION_RESULTS);
const isAdverseResult = (result: string): result is AutofixAdverseResult => ADVERSE_RESULT_SET.has(result);
/** The writer's closed fixer vocabulary: FIXER_IDS plus the ledger-only 'pinned-hand-edit' pseudo-fixer. */
const FIXER_VOCABULARY = new Set<string>([...FIXER_IDS, 'pinned-hand-edit']);
/** The writer's closed incident-status vocabulary (IncidentStatusLine). */
const INCIDENT_STATUS_VOCABULARY = new Set(['fixed', 'failed', 'intentional', 'refused']);
/** Incident statuses that are adverse evidence; fixed and intentional are success/by-design. */
const ADVERSE_INCIDENT_STATUSES = ['failed', 'refused'] as const;
export type AutofixAdverseIncidentStatus = (typeof ADVERSE_INCIDENT_STATUSES)[number];
const ADVERSE_INCIDENT_STATUS_SET: ReadonlySet<string> = new Set(ADVERSE_INCIDENT_STATUSES);
const isAdverseIncidentStatus = (status: string): status is AutofixAdverseIncidentStatus =>
  ADVERSE_INCIDENT_STATUS_SET.has(status);

export interface AutofixItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding ledger/autofix.jsonl and ledger/incidents.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default AUTOFIX_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default AUTOFIX_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated autofix.jsonl row: the fixer action outcome the ledger recorded. */
export interface AutofixActionRow {
  atMs: number;
  utcDay: string;
  fixer: string;
  target: string;
  action: string;
  result: string;
}

/** One validated incidents.jsonl row: an incident's recorded outcome transition. */
export interface AutofixIncidentRow {
  atMs: number;
  utcDay: string;
  /** The incident key exactly as recorded (INCIDENT_KEY_RE shape). */
  key: string;
  /** The writer's own classification: the mapped fixer id or 'unknown-prefix'. */
  cls: string;
  status: string;
  reason: string;
}

export interface AutofixTally {
  /** Sanitized recorded text (a result or reason label). */
  text: string;
  count: number;
}

/** One (fixer, action, result) cell: recurring adverse action outcomes plus the recorded detail the prompt quotes. */
export interface AutofixActionCell {
  fixer: string;
  action: string;
  result: AutofixAdverseResult;
  /** In-window adverse rows in the cell. */
  rows: number;
  /** Distinct recorded targets the rows name. */
  units: number;
  /** Distinct UTC days the rows fall on. */
  days: Set<string>;
  /** Up to MAX_EXAMPLES recorded targets. */
  examples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** One (class, status) cell: recurring incident outcomes plus the recorded detail the prompt quotes. */
export interface AutofixIncidentCell {
  cls: string;
  status: AutofixAdverseIncidentStatus;
  /** Distinct incident keys the journal recorded inside the window. */
  units: number;
  /** In-window journal rows in the cell. */
  rows: number;
  /** Distinct UTC days the rows fall on. */
  days: Set<string>;
  /** Recorded reasons, most frequent first (capped at MAX_PROMPT_TALLIES). */
  reasons: AutofixTally[];
  /** Up to MAX_EXAMPLES incident keys — the incidents that keep recurring. */
  examples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

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

/**
 * Pure: validate one parsed autofix.jsonl line against the writer's
 * LedgerLine contract — the fields the fold reads plus the closed
 * fixer/result vocabularies guard.ts's readLedger and types.ts's
 * FixerId/FixResult enforce. before/after stay unread: the fold never
 * quotes them, so their shape is not the fold's business. Anything else
 * is not a ledger row.
 */
export function parseAutofixActionEntry(value: unknown): AutofixActionRow | null {
  if (!isRecord(value)) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const fixer = value['fixer'];
  if (typeof fixer !== 'string' || !FIXER_VOCABULARY.has(fixer)) return null;
  const target = value['target'];
  if (!boundedText(target, 200)) return null;
  const action = value['action'];
  if (!boundedText(action, 120)) return null;
  const result = value['result'];
  if (typeof result !== 'string' || !RESULT_VOCABULARY.has(result)) return null;
  return { atMs, utcDay: utcDayOf(atMs), fixer, target, action, result };
}

/**
 * Pure: parse one autofix.jsonl file's text into validated rows plus the
 * count of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseAutofixActionJournal(text: string): { rows: AutofixActionRow[]; invalidRows: number } {
  const rows: AutofixActionRow[] = [];
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
    const row = parseAutofixActionEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/**
 * Pure: validate one parsed incidents.jsonl line against the writer's
 * IncidentStatusLine contract — INCIDENT_KEY_RE key, the closed status
 * vocabulary, a string reason and a parseable ts, matching
 * readIncidentStatuses plus the timestamp the fold windows on. The
 * class is the writer's own parseIncidentFilename classification, never
 * a re-guess.
 */
export function parseAutofixIncidentEntry(value: unknown): AutofixIncidentRow | null {
  if (!isRecord(value)) return null;
  const key = value['key'];
  if (typeof key !== 'string' || !INCIDENT_KEY_RE.test(key)) return null;
  const status = value['status'];
  if (typeof status !== 'string' || !INCIDENT_STATUS_VOCABULARY.has(status)) return null;
  const reason = value['reason'];
  if (typeof reason !== 'string' || reason.length > 4000) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const parsed = parseIncidentFilename(`INCIDENT-${key}.md`);
  const cls = parsed !== null && 'fixer' in parsed ? parsed.fixer : 'unknown-prefix';
  return { atMs, utcDay: utcDayOf(atMs), key, cls, status, reason };
}

/**
 * Pure: parse one incidents.jsonl file's text into validated rows plus
 * the count of lines that were not on-contract records.
 */
export function parseAutofixIncidentJournal(text: string): { rows: AutofixIncidentRow[]; invalidRows: number } {
  const rows: AutofixIncidentRow[] = [];
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
    const row = parseAutofixIncidentEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): AutofixTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + AUTOFIX_FUTURE_SKEW_MS;

/**
 * Pure: fold validated action rows into per-(fixer, action, result)
 * cells over the adverse results only. Rows outside the window never
 * join a cell; valid non-adverse rows are simply not evidence.
 */
export function foldAutofixActionCells(
  rows: readonly AutofixActionRow[],
  opts: { nowMs: number; windowMs?: number },
  lowerBound = false,
): AutofixActionCell[] {
  const windowMs = opts.windowMs ?? AUTOFIX_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, {
    fixer: string;
    action: string;
    result: AutofixAdverseResult;
    rows: number;
    targets: Set<string>;
    days: Set<string>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const row of rows) {
    if (!isAdverseResult(row.result)) continue;
    if (!inWindow(row.atMs, windowStart, opts.nowMs)) continue;
    const key = JSON.stringify([row.fixer, row.action, row.result]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        fixer: row.fixer, action: row.action, result: row.result,
        rows: 0, targets: new Set(), days: new Set(), firstMs: null, lastMs: null,
      };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.targets.add(row.target);
    cell.days.add(row.utcDay);
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      fixer: cell.fixer,
      action: cell.action,
      result: cell.result,
      rows: cell.rows,
      units: cell.targets.size,
      days: cell.days,
      examples: [...cell.targets].slice(0, MAX_EXAMPLES).map((target) => fieldText(target)),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.rows - a.rows || b.units - a.units || a.fixer.localeCompare(b.fixer) || a.action.localeCompare(b.action));
}

/**
 * Pure: fold validated incident rows into per-(class, status) cells over
 * the adverse statuses only. Rows outside the window never join a cell.
 */
export function foldAutofixIncidentCells(
  rows: readonly AutofixIncidentRow[],
  opts: { nowMs: number; windowMs?: number },
  lowerBound = false,
): AutofixIncidentCell[] {
  const windowMs = opts.windowMs ?? AUTOFIX_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, {
    cls: string;
    status: AutofixAdverseIncidentStatus;
    rows: number;
    keys: Set<string>;
    days: Set<string>;
    reasons: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const row of rows) {
    if (!isAdverseIncidentStatus(row.status)) continue;
    if (!inWindow(row.atMs, windowStart, opts.nowMs)) continue;
    const key = JSON.stringify([row.cls, row.status]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        cls: row.cls, status: row.status,
        rows: 0, keys: new Set(), days: new Set(), reasons: new Map(), firstMs: null, lastMs: null,
      };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.keys.add(row.key);
    cell.days.add(row.utcDay);
    bump(cell.reasons, fieldText(row.reason) || '(no reason recorded)');
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      cls: cell.cls,
      status: cell.status,
      units: cell.keys.size,
      rows: cell.rows,
      days: cell.days,
      reasons: tallyOf(cell.reasons, MAX_PROMPT_TALLIES),
      examples: [...cell.keys].slice(0, MAX_EXAMPLES).map((incidentKey) => fieldText(incidentKey)),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.units - a.units || b.rows - a.rows || a.cls.localeCompare(b.cls) || a.status.localeCompare(b.status));
}

/** The evidence pointers every prompt shares; the write-only-ledger gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is <runs>/ledger/autofix.jsonl and <runs>/ledger/incidents.jsonl — the runs dir resolves as $ASHLR_RUNS_DIR, then ~/.ashlr-runs. runAutofix (src/core/autofix/run.ts) appends one LedgerLine per non-skipped action outcome through appendLedger and one IncidentStatusLine per outcome transition through record, on every `phm autofix` pass driven by the INCIDENT-<key>.md files the Eng Ops self_aware.py tick writes under <runs>/bus/core/. The ledgers\' only readers are the pass itself — readLedger\'s alreadyRecorded idempotency dedup and readIncidentStatuses\' terminalIncident/previousSame transition dedup — plus `phm autofix --json\'s current-pass print. Until this feed the history had no recurrence fold at all.';

const NO_CHANGE = 'If the window has rolled forward, the rows were a one-off burst the fixer already absorbed, the refusals were the safety guards correctly declining work a person or pinned machinery owns (credentials, billing, host load, Security GATES v3 files under contrib/mac and ~/.ashlr-runs/bin), the incidents were since resolved or their keys retired, or the cause is owner-only or Eng Ops producer-side (self_aware.py, outside this repository) — report no-change and name the evidence.';

function tallyText(tallies: readonly AutofixTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(firstSeen: string | null, lastSeen: string | null): string {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
}

function examplesText(examples: readonly string[]): string {
  return examples.length === 0 ? '' : ` Example targets: ${examples.join(', ')}.`;
}

function boundText(lowerBound: boolean): string {
  return lowerBound ? ' A bounded ledger tail was truncated, so these counts are a lower bound.' : '';
}

/** File-level read tallies every prompt states alongside the per-cell bound note. */
interface Coverage {
  invalidRows: number;
  unreadableFiles: number;
}

function coverageNote(coverage: Coverage): string {
  const notes: string[] = [];
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract lines dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} ledger file(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function actionTitle(cell: AutofixActionCell): string {
  switch (cell.result) {
    case 'failed':
      return `Autofix ${cell.fixer} '${cell.action}' keeps failing`;
    case 'refused_admitted':
      return `Autofix ${cell.fixer} '${cell.action}' keeps refused by resident admission`;
    case 'refused_stale':
      return `Autofix ${cell.fixer} '${cell.action}' keeps refused on stale evidence`;
    case 'detect-only':
      return `Autofix ${cell.fixer} '${cell.action}' keeps flagging detect-only reports`;
    default:
      return `Autofix ${cell.fixer} '${cell.action}' keeps refused`;
  }
}

function failedPrompt(cell: AutofixActionCell, coverage: Coverage): string {
  return [
    `Phantom's Eng Ops autofix keeps failing the same action — ${cell.fixer} '${cell.action}' recorded ${cell.rows} failed outcome(s) across ${cell.units} distinct target(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one pass where the fixer attempted '${cell.action}' for ${cell.fixer} and the underlying operation threw — 'failed' is non-terminal in the writer's dedup, so a persistently broken action appends a fresh row every pass.${examplesText(cell.examples)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the action keeps failing: the fixers live in src/core/autofix/ (fixers.ts for release drafts, stuck lanes and load renice; launchd.ts for crashloop disables; run.ts for the per-incident dispatch). Check whether the failure is this repository's — a host seam that throws where it should degrade, a precondition the fixer computes wrong, a ledger write that fails — or pinned/host-side (launchctl, gh, renice, the Eng Ops self_aware.py producer outside this repo, Security GATES v3 files under contrib/mac and ~/.ashlr-runs/bin). Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function refusedPrompt(cell: AutofixActionCell, coverage: Coverage): string {
  const clause = cell.result === 'refused_admitted'
    ? 'each a \'refused_admitted\' outcome — resident admission reported admitted with an active grant, so the launchd disable was refused and an RQ note was filed instead'
    : cell.result === 'refused_stale'
      ? 'each a \'refused_stale\' outcome — the crashloop evidence never freshened enough for the disable guard to act'
      : 'each a \'refused\' outcome — a refuse-* guard declined the action before it ran';
  return [
    `Phantom's Eng Ops autofix keeps hitting the same refusal — ${cell.fixer} '${cell.action}' recorded ${cell.rows} '${cell.result}' outcome(s) across ${cell.units} distinct target(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one pass where the guard refused before acting — ${clause}. Terminal refusals re-record only when their before-state drifts, so repeated rows mean the blocking condition kept presenting fresh evidence.${examplesText(cell.examples)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the guard keeps refusing: the refusal vocabulary lives in src/core/autofix/ — launchd.ts's refuse-domain/refuse-stale-runs/refuse-operator-start/refuse-admission-unknown/refuse-disable chain, fixers.ts's refuse-* preconditions (attest coverage, slots target, lane shape, load measurement) and run.ts's per-key refuse-* dispatch. Check whether the precondition is unsatisfiable by construction (a threshold that never clears, a key shape the producer drifted from, evidence that can never freshen), whether the guard misreads its inputs, or whether the refusal is the safety system correctly declining work only a person or pinned machinery owns. Fix what lives here; if the cause is ops-pinned machinery, host state, Eng Ops producer-side or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function detectOnlyPrompt(cell: AutofixActionCell, coverage: Coverage): string {
  return [
    `Phantom's Eng Ops autofix keeps filing detect-only security reports — ${cell.fixer} '${cell.action}' recorded ${cell.rows} detect-only outcome(s) across ${cell.units} distinct target(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one pass where pinnedDrift or an autorun-hold incident detected drift on an installed pinned file or a release-autorun hold and filed a report under <runs>/ledger/autofix-security/ without changing anything — the Security-review path working as designed, but the underlying condition keeps recurring.${examplesText(cell.examples)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the pinned files or autorun holds keep drifting: pinnedDrift and reportPinnedHandEdit live in src/core/autofix/fixers.ts, the hold path in run.ts and incidents.ts's securityReportForHold, and the expected hashes the drift check compares against come from this repository's pinned-file manifest. Check whether the expected hashes went stale after a sanctioned reinstall or version bump (the manifest side is this repo's), whether the same files keep being edited by a tool that should route through the pinned install path, or whether the holds reflect a real release-pipeline problem the autorun side owns. The files themselves and any restore are Security GATES v3 territory — never edit or restore them here. Fix what lives here; if the cause is ops-pinned machinery, Security review or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function incidentFailedPrompt(cell: AutofixIncidentCell, coverage: Coverage): string {
  return [
    `Phantom's Eng Ops autofix keeps failing whole incident classes — '${cell.cls}' incidents recorded ${cell.units} distinct key(s) across ${cell.rows} failed transition(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one incident whose fixer ran and still ended 'failed' — the pass tried the class's action and something in it threw. Incident rows are transition-deduped, so distinct keys across days are the recurrence signal, not row count.${cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`}${examplesText(cell.examples)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why this incident class keeps failing: the class maps through INCIDENT_FIXER_TABLE in src/core/autofix/incidents.ts to its fixer — release-stuck-draft, launchd-crashloop, stuck-lane, outside-load or autorun-hold — whose actions live in fixers.ts, launchd.ts and run.ts. Check whether the failures cluster on one action (join the example keys to the action cells this feed also emits), on a class whose underlying condition the fixer was never built to resolve, on incident keys whose shape drifted from what the fixers parse, or on host/pinned causes only a person can clear. Fix what lives here; if the cause is ops-pinned machinery, the Eng Ops self_aware.py producer, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function incidentRefusedPrompt(cell: AutofixIncidentCell, coverage: Coverage): string {
  return [
    `Phantom's Eng Ops autofix keeps refusing whole incident classes — '${cell.cls}' incidents recorded ${cell.units} distinct key(s) across ${cell.rows} refused transition(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one incident that ended 'refused' — the fixer declined it for good this pass: a refuse-* precondition, 'no-action' (every planned line was already recorded), 'detect-only-security' for autorun holds, or 'unknown-prefix' for keys the prefix table does not know. 'unknown-prefix' cells specifically mean the Eng Ops producer is emitting keys this repository's INCIDENT_FIXER_TABLE cannot classify.${cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`}${examplesText(cell.examples)}${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why this incident class keeps being refused: the classification and refusal reasons live in src/core/autofix/incidents.ts (parseIncidentFilename, INCIDENT_FIXER_TABLE, statusOf's reason mapping in run.ts). Check whether the keys the producer emits drifted from the table's prefixes, whether a class's preconditions are unsatisfiable so every incident refuses, whether 'no-action' rows mark incidents whose fixes already landed but whose files linger (a producer-side cleanup gap), or whether the refusals are the safety system correctly declining work only a person or pinned machinery owns. Fix what lives here; if the cause is ops-pinned machinery, the Eng Ops self_aware.py producer, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const ACTION_TITLES: Record<AutofixAdverseResult, (cell: AutofixActionCell) => string> = {
  failed: actionTitle,
  refused: actionTitle,
  refused_admitted: actionTitle,
  refused_stale: actionTitle,
  'detect-only': actionTitle,
};

const ACTION_PROMPTS: Record<AutofixAdverseResult, (cell: AutofixActionCell, coverage: Coverage) => string> = {
  failed: failedPrompt,
  refused: refusedPrompt,
  refused_admitted: refusedPrompt,
  refused_stale: refusedPrompt,
  'detect-only': detectOnlyPrompt,
};

function actionItem(cell: AutofixActionCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const id = `autofix-action-${createHash('sha256').update(`autofix-action:${cell.fixer}:${cell.action}:${cell.result}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: ACTION_TITLES[cell.result](cell).slice(0, MAX_TITLE_CHARS),
    prompt: ACTION_PROMPTS[cell.result](cell, coverage),
    area: 'autofix',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function incidentTitle(cell: AutofixIncidentCell): string {
  return cell.status === 'failed'
    ? `Autofix '${cell.cls}' incidents keep failing`
    : `Autofix '${cell.cls}' incidents keep being refused`;
}

function incidentItem(cell: AutofixIncidentCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const id = `autofix-incident-${createHash('sha256').update(`autofix-incident:${cell.cls}:${cell.status}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: incidentTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cell.status === 'failed' ? incidentFailedPrompt(cell, coverage) : incidentRefusedPrompt(cell, coverage),
    area: 'autofix',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

interface FoldedAutofix {
  actions: AutofixActionCell[];
  incidents: AutofixIncidentCell[];
}

/**
 * Backlog items for the Eng Ops autofix ledgers' recurring adverse
 * cells: (fixer, action, result) action cells at the row+day bars and
 * (class, status) incident cells at the distinct-key+day bars. Total:
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function autofixBacklogItems(opts: AutofixItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AUTOFIX_WINDOW_MS;

    // Both ledgers are read independently — a missing one is the
    // writer's normal state (fresh install, or a ledger never appended).
    const [actionRead, incidentRead] = await Promise.all([
      readLedgerTail(ledgerPath(runsDir), AUTOFIX_TAIL_BYTES),
      readLedgerTail(incidentsLedgerPath(runsDir), AUTOFIX_TAIL_BYTES),
    ]);
    const actionRows: AutofixActionRow[] = [];
    const incidentRows: AutofixIncidentRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    // A file that vanished between stat and open is a non-event; anything
    // else unreadable is stated in the coverage note, never guessed.
    if (actionRead.state === 'read') {
      if (actionRead.truncated) truncatedFiles += 1;
      const parsed = parseAutofixActionJournal(actionRead.text);
      actionRows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    } else if (actionRead.state !== 'missing') unreadableFiles += 1;
    if (incidentRead.state === 'read') {
      if (incidentRead.truncated) truncatedFiles += 1;
      const parsed = parseAutofixIncidentJournal(incidentRead.text);
      incidentRows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    } else if (incidentRead.state !== 'missing') unreadableFiles += 1;
    if (actionRows.length === 0 && incidentRows.length === 0) return [];

    const lowerBound = truncatedFiles > 0;
    const windowOpts = { nowMs, windowMs };
    const folded: FoldedAutofix = {
      actions: foldAutofixActionCells(actionRows, windowOpts, lowerBound),
      incidents: foldAutofixIncidentCells(incidentRows, windowOpts, lowerBound),
    };
    const recurringActions = folded.actions.filter(
      (cell) => cell.rows >= AUTOFIX_MIN_ROWS && cell.days.size >= AUTOFIX_MIN_DAYS,
    );
    const recurringIncidents = folded.incidents.filter(
      (cell) => cell.units >= AUTOFIX_MIN_INCIDENTS && cell.days.size >= AUTOFIX_MIN_DAYS,
    );
    if (recurringActions.length === 0 && recurringIncidents.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? AUTOFIX_BACKLOG_MAX_ITEMS, AUTOFIX_ITEM_HARD_MAX));
    const coverage: Coverage = { invalidRows, unreadableFiles };
    const items: CloudBacklogItem[] = [
      ...recurringActions.map((cell) => actionItem(cell, repo, coverage)),
      ...recurringIncidents.map((cell) => incidentItem(cell, repo, coverage)),
    ];
    // Action cells sort ahead of incident cells — the action ledger is
    // the finer-grained machinery evidence.
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
