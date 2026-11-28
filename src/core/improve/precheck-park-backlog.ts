/**
 * jobs.jsonl precheck_parked rows → self-improvement backlog items.
 *
 * The dispatcher's claim loop parks a job whose empty-run precheck
 * (contrib/precheck.sh via contrib/mac/launch_precheck.py) returns the
 * unproven-completion verdict — exit code 13 — instead of skipping it:
 * the job stays queued and every pass appends one
 * `precheck_parked` row to metrics/jobs.jsonl carrying the job id, repo,
 * lane, code, the recorded reason (`files_and_tests_exist`,
 * `symbols_defined`, `unproven_completion`,
 * `invalid_or_unknown_receipt`), the epoch-seconds retry_at the
 * exponential backoff scheduled (1, 2, 4 … 60 minutes, capped at seven
 * attempts — past the cap the job keeps cycling hourly) and the park
 * attempt count. A park is a defer, never a decline: the fleet spent a
 * queue slot deciding the work looked done but could not prove it, and
 * no agent ever ran.
 *
 * Until now the rows only ever fed aggregates — `phm fleet parked
 * --json`'s health tallies, the friction feed's 'holds' category and
 * the router outcome fold's defer accounting — reports someone had to
 * run and read. precheckParkBacklogItems carries the same rows into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue recurring park evidence exactly like the
 * precheck-skip, usage-gap and fleet-controller sources beside it.
 *
 * Two evidence kinds in that stream never became work:
 *
 *  - A recorded reason recurring across distinct jobs: the same park
 *    signature finishing many different jobs inside the window.
 *    `files_and_tests_exist` or `symbols_defined` recurring means
 *    producers keep minting work master already satisfies but the
 *    precheck cannot prove — queuegen proposals, router-queue rows,
 *    backlog-discovered items — or one precheck rule now misfires on a
 *    whole class of jobs. `unproven_completion` or
 *    `invalid_or_unknown_receipt` recurring means the receipt contract
 *    between precheck.sh and launch_precheck.py drifted — evidence
 *    that lives in this repository's contrib/precheck.sh and the
 *    detector code that reads it.
 *  - One job id parked again and again: each row is one re-park cycle,
 *    so a repeat means the same job has been deferring for days —
 *    either legitimately waiting on upstream state the precheck keeps
 *    re-checking, or a job whose acceptance evidence can never satisfy
 *    the gate, cycling the backoff ladder (attempt ≥ 7) forever.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail — the same ROUTER_OUTCOME_LEDGER_LIMIT
 *    window the router outcome and usage-gap folds read — nothing is
 *    written and no network is touched. A missing or unreadable file
 *    yields no items.
 *  - Rows count only under the jobs-ledger dialect: JSON objects with a
 *    bounded job id (job|job_id|jobId|id), the 'precheck_parked'
 *    lifecycle event across event|type|kind, and a timestamp inside
 *    the window — dispatchd writes ts in local wall time with a %z
 *    offset, which parseLedgerTs normalizes. Node-pool producer
 *    schemas, malformed lines and every other event are skipped, never
 *    guessed.
 *  - Recurring means recorded across days: a reason cell emits only at
 *    PRECHECK_PARK_MIN_JOBS distinct jobs across PRECHECK_PARK_MIN_DAYS
 *    distinct UTC days inside the 7-day window, and a job cell only at
 *    that many recorded park rows across those days — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply.
 *  - The park machinery is pinned ops machinery. contrib/mac's
 *    launch_precheck.py, precheck.sh and dispatchd.py are
 *    Security-reviewed and re-pinned; agents never edit the live
 *    copies. The ledger rows do carry a repo column, but the park
 *    decision is this install's dispatcher serving every repo it runs
 *    — items still emit only when the backlog target's repository name
 *    is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply, and their prompts direct sessions
 *    to fix what this repository owns (the precheck receipt contract
 *    under contrib/, the queue producers and dedup in src/core/queue,
 *    the detectors that read this evidence) or report no-change naming
 *    pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    recorded reason, or the job id — never the counts or timestamps),
 *    so a refresh re-derives the same id and appendUserBacklogItems
 *    adds only what is new; a cell that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the ledger's
 *    own id shape before they are quoted, reason strings are scrubbed,
 *    flattened and capped, the attempt tally names how deep into the
 *    backoff ladder the parks ran, and the brief carries the usual
 *    no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerEventName, ledgerJobId, ledgerLane, ledgerPhase } from '../fleet/empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs } from '../fleet/jobs-ledger-dialect.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; park reasons are a small closed vocabulary. */
export const PRECHECK_PARK_MAX_ITEMS = 8;
const PRECHECK_PARK_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const PRECHECK_PARK_WINDOW_HOURS = 168;
/** A reason cell emits only at the fleet's recurring bar of distinct jobs... */
export const PRECHECK_PARK_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const PRECHECK_PARK_MIN_DAYS = 2;
/** A job cell emits only at the same recurring bar of recorded park rows... */
export const PRECHECK_PARK_MIN_ROWS = 3;
/** Bounded tail of the append-only jobs ledger — the same
 * ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome and usage-gap
 * folds read, so the backlog sees exactly the evidence `phm fleet
 * parked --json` and the friction feed fold; prompts state any
 * truncation as a lower bound.
 */
const PRECHECK_PARK_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: park evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Job ids name log files; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Reason strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_REASON_CHARS = 160;
/** Reason characters quoted inside one title before the remainder is elided. */
const TITLE_REASON_MAX = 80;
/** Lane/repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** The park backoff ladder's depth: launch_precheck.py caps attempts at seven, after which the job cycles hourly. */
const PARK_BACKOFF_CAP = 7;

export interface PrecheckParkItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default PRECHECK_PARK_WINDOW_HOURS). */
  windowHours?: number;
  /** Ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default PRECHECK_PARK_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the jobs-ledger tail
// ---------------------------------------------------------------------------

/** One validated precheck_parked row inside the window. */
interface ParkRow {
  job: string;
  /** Sanitized recorded reason ('unrecorded reason' when the row carried none). */
  reason: string;
  /** Recorded exit code as written ('unrecorded code' when absent). */
  code: string;
  /** Recorded park attempt when the row carried a bounded integer, else null. */
  attempt: number | null;
  /** Sanitized lane label ('unknown' when the row carried none). */
  lane: string;
  /** Sanitized repo label ('unattributed' when the row carried none). */
  repo: string;
  atMs: number;
}

function parkReason(row: Record<string, unknown>): string {
  const value = row['reason'];
  if (typeof value !== 'string' || value.trim() === '') return 'unrecorded reason';
  return fieldText(value, MAX_REASON_CHARS) || 'unrecorded reason';
}

function parkCode(row: Record<string, unknown>): string {
  const value = row['code'];
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return fieldText(value, MAX_NAME_CHARS) || 'unrecorded code';
  return 'unrecorded code';
}

function parkAttempt(row: Record<string, unknown>): number | null {
  const value = row['attempt'];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.trunc(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    if (n >= 1) return n;
  }
  return null;
}

function parkLabel(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return fieldText(value, MAX_NAME_CHARS) || fallback;
}

/**
 * Pure: fold one jobs-ledger tail into validated precheck_parked rows.
 * Node-pool producer schemas, malformed JSON, every other event name,
 * unsafe job ids and rows whose timestamp cannot be placed inside
 * [nowMs - windowMs, nowMs + skew] are skipped, never guessed.
 */
export function foldPrecheckParkJournal(
  text: string,
  nowMs: number,
  windowHours: number,
): { rows: ParkRow[]; malformed: number } {
  const out: ParkRow[] = [];
  let malformed = 0;
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    // Cheap prefilter: park rows are a minority of the ledger's rows.
    if (!line.includes('precheck_parked')) continue;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!isRecord(row)) { malformed++; continue; }
    if (isNodePoolLedgerRow(row)) continue;
    if (ledgerEventName(row) !== 'precheck_parked') continue;
    const job = ledgerJobId(row);
    if (job === null || !SAFE_JOB_ID.test(job)) continue;
    const atMs = ledgerEventTs(row, ledgerPhase(row));
    if (atMs === null || atMs < since || atMs > until) continue;
    const lane = ledgerLane(row);
    out.push({
      job,
      reason: parkReason(row),
      code: parkCode(row),
      attempt: parkAttempt(row),
      lane: lane === null || lane.trim() === '' ? 'unknown' : fieldText(lane, MAX_NAME_CHARS) || 'unknown',
      repo: parkLabel(row, 'repo', 'unattributed'),
      atMs,
    });
  }
  return { rows: out, malformed };
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface PrecheckParkTally {
  /** Sanitized recorded text (a lane or repo label). */
  text: string;
  count: number;
}

/** The two recorded park shapes; they need different fixes so they never share a cell. */
export type PrecheckParkKind = 'reason' | 'job';

/** One emitted park cell: a recurring reason across jobs, or one repeatedly-parked job. */
export interface PrecheckParkCell {
  kind: PrecheckParkKind;
  /** reason cells: the recorded reason, verbatim (sanitized). */
  reason: string;
  /** job cells: the job id the ledger kept parking. */
  job: string;
  /** reason cells: distinct job ids inside the window; job cells: recorded park rows. */
  count: number;
  /** Total recorded park rows folded into the cell. */
  rows: number;
  /** Distinct UTC days the rows landed on. */
  days: string[];
  /** Deepest recorded park attempt in the cell, or null when no row carried one. */
  maxAttempt: number | null;
  /** Recorded exit codes, most frequent first. */
  codes: PrecheckParkTally[];
  /** Recorded reasons, most frequent first (job cells mainly). */
  reasons: PrecheckParkTally[];
  /** Recorded lane tallies ('unknown' when the ledger named none), most frequent first. */
  lanes: PrecheckParkTally[];
  /** Recorded repo tallies ('unattributed' when the ledger named none), most frequent first. */
  repos: PrecheckParkTally[];
  /** Up to MAX_EXAMPLES fleet-shaped job ids (reason cells). */
  jobs: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

interface CellAcc {
  kind: PrecheckParkKind;
  reason: string;
  job: string;
  rows: number;
  jobs: Set<string>;
  days: Set<string>;
  maxAttempt: number | null;
  codes: Map<string, number>;
  reasons: Map<string, number>;
  lanes: Map<string, number>;
  repos: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

function newAcc(kind: PrecheckParkKind, row: ParkRow): CellAcc {
  return {
    kind,
    reason: kind === 'reason' ? row.reason : '',
    job: kind === 'job' ? row.job : '',
    rows: 0,
    jobs: new Set<string>(),
    days: new Set<string>(),
    maxAttempt: null,
    codes: new Map<string, number>(),
    reasons: new Map<string, number>(),
    lanes: new Map<string, number>(),
    repos: new Map<string, number>(),
    firstMs: null,
    lastMs: null,
  };
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function foldRow(acc: CellAcc, row: ParkRow): void {
  acc.rows += 1;
  acc.jobs.add(row.job);
  acc.days.add(dayOf(row.atMs));
  if (row.attempt !== null) acc.maxAttempt = acc.maxAttempt === null ? row.attempt : Math.max(acc.maxAttempt, row.attempt);
  bump(acc.codes, row.code);
  bump(acc.reasons, row.reason);
  bump(acc.lanes, row.lane);
  bump(acc.repos, row.repo);
  acc.firstMs = acc.firstMs === null ? row.atMs : Math.min(acc.firstMs, row.atMs);
  acc.lastMs = acc.lastMs === null ? row.atMs : Math.max(acc.lastMs, row.atMs);
}

function tallyOf(map: Map<string, number>, max: number): PrecheckParkTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

function toCell(acc: CellAcc, lowerBound: boolean): PrecheckParkCell {
  return {
    kind: acc.kind,
    reason: acc.reason,
    job: acc.job,
    count: acc.kind === 'reason' ? acc.jobs.size : acc.rows,
    rows: acc.rows,
    days: [...acc.days].sort(),
    maxAttempt: acc.maxAttempt,
    codes: tallyOf(acc.codes, MAX_PROMPT_TALLIES),
    reasons: tallyOf(acc.reasons, MAX_PROMPT_TALLIES),
    lanes: tallyOf(acc.lanes, MAX_PROMPT_TALLIES),
    repos: tallyOf(acc.repos, MAX_PROMPT_TALLIES),
    jobs: acc.kind === 'reason'
      ? [...acc.jobs].filter((job) => SAFE_JOB_ID.test(job)).slice(0, MAX_EXAMPLES)
      : acc.job !== '' && SAFE_JOB_ID.test(acc.job) ? [acc.job] : [],
    firstSeen: isoOrNull(acc.firstMs),
    lastSeen: isoOrNull(acc.lastMs),
    lowerBound,
  };
}

/**
 * Pure: recurring park cells — a reason recorded on enough distinct
 * jobs across enough distinct UTC days, or one job parked enough
 * recorded times across those days. Sorted by count, the worst park
 * pressure first.
 */
export function precheckParkCells(rows: readonly ParkRow[], lowerBound = false): PrecheckParkCell[] {
  const reasons = new Map<string, CellAcc>();
  const jobs = new Map<string, CellAcc>();
  for (const row of rows) {
    let rcell = reasons.get(row.reason);
    if (rcell === undefined) { rcell = newAcc('reason', row); reasons.set(row.reason, rcell); }
    foldRow(rcell, row);
    let jcell = jobs.get(row.job);
    if (jcell === undefined) { jcell = newAcc('job', row); jobs.set(row.job, jcell); }
    foldRow(jcell, row);
  }
  const cells: PrecheckParkCell[] = [];
  for (const acc of reasons.values()) {
    if (acc.jobs.size < PRECHECK_PARK_MIN_JOBS || acc.days.size < PRECHECK_PARK_MIN_DAYS) continue;
    cells.push(toCell(acc, lowerBound));
  }
  for (const acc of jobs.values()) {
    if (acc.rows < PRECHECK_PARK_MIN_ROWS || acc.days.size < PRECHECK_PARK_MIN_DAYS) continue;
    cells.push(toCell(acc, lowerBound));
  }
  return cells.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason) || a.job.localeCompare(b.job));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the dispatchd claim loop appends one precheck_parked row each time a queued job\'s empty-run precheck returns the unproven-completion verdict — job id, repo, lane, code, reason, the scheduled retry_at and the park attempt — while the job stays queued on exponential backoff. `phm fleet parked --json` folds the same rows into the queue-health report\'s hold tallies, the friction feed counts them under its \'holds\' category, and the router outcome fold treats them as defer events. The precheck itself is contrib/precheck.sh plus contrib/mac/launch_precheck.py — pinned, Security-reviewed ops machinery agents never edit live.';

const PINNED_NOTE = ' contrib/mac/launch_precheck.py, contrib/precheck.sh and contrib/mac/dispatchd.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — preview with contrib/mac/install.sh --dry-run --json and never install over the live pinned copy. Prefer evidence-backed changes in this repository\'s src/ and contrib/ where the cause lives (the receipt contract between precheck.sh and launch_precheck.py, the queue producers and dedup in src/core/queue, the detectors that read this evidence), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the parks were a one-off burst the fleet recovered from, the precheck correctly refused work that was genuinely unproven, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed dispatcher/precheck files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/**
 * What each recorded reason means in the precheck's own vocabulary —
 * the verdict the receipt carried, quoted from launch_precheck.py's
 * park() call sites so the session starts from the producer's
 * semantics rather than guessing. Unknown reasons (a producer's own
 * bounded vocabulary drift) fall back to the recorded text alone.
 */
const REASON_HINTS: Record<string, string> = {
  'files_and_tests_exist': 'the job\'s named files and tests already exist on master — the work looks done but the precheck cannot prove it',
  'symbols_defined': 'the job\'s named symbols are already defined — same done-but-unproven shape as files_and_tests_exist',
  'unproven_completion': 'the precheck ran its checks but the completion receipt stayed unproven — the fallback verdict when no sharper reason applied',
  'invalid_or_unknown_receipt': 'the precheck\'s completion receipt was missing, malformed or carried a verdict the parser does not know — a contract drift between precheck.sh and launch_precheck.py',
};

const tallyText = (tallies: readonly PrecheckParkTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: PrecheckParkCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: PrecheckParkCell): string =>
  cell.lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const attemptText = (cell: PrecheckParkCell): string => {
  if (cell.maxAttempt === null) return '';
  const deep = cell.maxAttempt >= PARK_BACKOFF_CAP ? ` — at or past the ${PARK_BACKOFF_CAP}-attempt backoff cap, so the job now cycles hourly` : '';
  return ` Deepest recorded park attempt: ${cell.maxAttempt}${deep}.`;
};

function reasonPrompt(cell: PrecheckParkCell): string {
  const reason = fieldText(cell.reason, TITLE_REASON_MAX * 2);
  const hint = REASON_HINTS[cell.reason];
  const lanes = cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const examples = cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
  return [
    `Phantom's launch precheck keeps parking queued jobs instead of skipping or launching them — ${cell.count} distinct job(s) parked ${cell.rows} recorded time(s) inside the window for reason '${reason}' across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each precheck_parked row is one defer: the empty-run precheck returned the unproven-completion verdict, so the job stayed queued on exponential backoff and no agent ran.${hint === undefined ? '' : ` Recorded reason meaning: ${hint}.`}${attemptText(cell)}${lanes}${repos}${seenText(cell)}${examples}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `A park is usually the gate working as designed — the question is which producer keeps minting work master already satisfies but the precheck cannot prove, or whether one precheck rule or receipt contract now misfires on a whole class of jobs. Find which side owns the cause: the queue producers this repository owns (queuegen proposals, router-queue rows, cloud-backlog-discovered items, restock picks, issue triage) minting already-done work; the empty-run detectors and precheck receipt contract under src/core/queue and contrib/precheck.sh drifting; or job specs whose acceptance evidence the precheck can never satisfy. If the parks are the machinery correctly deferring genuinely unproven work — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function jobPrompt(cell: PrecheckParkCell): string {
  const reasons = cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`;
  const codes = cell.codes.length === 0 ? '' : ` Recorded codes: ${tallyText(cell.codes)}.`;
  const lanes = cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
  return [
    `Job '${cell.job}' was parked by the launch precheck ${cell.rows} recorded time(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) — the same queued job keeps deferring instead of launching or finishing, the self-improvement work this backlog exists for.`,
    '',
    `Each precheck_parked row is one re-park cycle on exponential backoff (1, 2, 4 … 60 minutes, capped at seven attempts — deeper attempts cycle hourly).${codes}${reasons}${attemptText(cell)}${lanes}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this job never satisfies the gate: read its queue row and spec (router-queue.md, ready.tsv, the backlog item it came from), check whether the precheck's named evidence genuinely does not exist yet or exists in a shape the detectors cannot see, and whether the job's acceptance text can never produce the receipt the precheck requires. If the job is legitimately waiting on upstream state that keeps changing, or the parks trace to pinned/owner-side causes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    `Fix what lives here — the job spec, its queue row, the detectors or producers this repository owns.${PINNED_NOTE} If the job already finished or was cancelled inside the window (the ledger tail only shows the park rows), report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function precheckParkItem(cell: PrecheckParkCell, repo: string): CloudBacklogItem {
  const hashInput = cell.kind === 'reason' ? `precheck-park-reason:${cell.reason}` : `precheck-park-job:${cell.job}`;
  const id = `fleet-precheck-park-${createHash('sha256').update(hashInput).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'reason'
    ? `Launch precheck keeps parking queued jobs: ${fieldText(cell.reason, TITLE_REASON_MAX)}`
    : `Job ${cell.job} keeps being parked by the launch precheck`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'reason' ? reasonPrompt(cell) : jobPrompt(cell),
    area: 'precheck-parks',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring precheck_parked cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function precheckParkBacklogItems(opts: PrecheckParkItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? PRECHECK_PARK_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, PRECHECK_PARK_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldPrecheckParkJournal(tail.text, nowMs, windowHours);
    if (fold.rows.length === 0) return [];
    const cells = precheckParkCells(fold.rows, tail.truncated === true);
    const limit = Math.max(1, Math.min(opts.limit ?? PRECHECK_PARK_MAX_ITEMS, PRECHECK_PARK_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => precheckParkItem(cell, repo));
  } catch {
    return [];
  }
}
