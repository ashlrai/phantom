/**
 * jobs.jsonl empty-gate skipped_empty rows → self-improvement backlog items.
 *
 * The fleet's empty-attempt gate declines a ready line instead of
 * launching it: dispatchd's claim loop runs launch_precheck.py's
 * empty_reason() against the job's attempt identity (repo, base_sha,
 * prompt_hash, task_hash, rebase_hash) and restock's pick pass runs the
 * same check before refilling ready.tsv. When the gate proves the work
 * already finished empty — an upkeep sweep on the same base, the same
 * prompt on the same base inside 24h, the same normalized task text
 * across ids inside 24h, or a rebase-drain request past its retry cap —
 * each writer appends one `skipped_empty` row to metrics/jobs.jsonl
 * carrying the job id, repo, lane, the recorded reason
 * (`upkeep_empty_same_base`, `prompt_empty_same_base_24h`,
 * `task_empty_repeat_24h`, `rebase_recut_published_inspect_replacement`,
 * `rebase_claim_in_flight_wait_for_finish`,
 * `rebase_retry_exhausted_3x_inspect_claims_change_head_or_task`) and a
 * timestamp — and no numeric `code`, which is what separates these
 * reason declines from the precheck declines the sibling feeds read
 * (dispatchd's DONE-NOOP path writes `code`, and isPrecheckSkipRow
 * claims every coded skipped_empty row). A decline never launches an
 * agent: dispatchd drops the ready row, restock skips the re-add, and
 * neither retires the router-queue line, so the same job can be
 * re-minted and re-declined every pass until the 24h empty evidence
 * ages out.
 *
 * Until now the rows only ever fed aggregates — the router outcome
 * fold's standing skipped/skip_reason decline per job, `phm jobs
 * skipped`'s per-job skip table, the empty-finishes readers' skipped
 * tallies and the queue/skipped-empty.tsv reports `phm fleet
 * skip-reasons` and `phm fleet dead-heads` print — reports someone had
 * to run and read. emptyGateBacklogItems carries the same rows into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue recurring empty-gate decline evidence exactly
 * like the precheck-skip, precheck-park and fleet-controller sources
 * beside it.
 *
 * Two evidence kinds in that stream never became work:
 *
 *  - A recorded reason recurring across distinct jobs: the same
 *    empty-gate verdict finishing many different jobs inside the
 *    window. `task_empty_repeat_24h` recurring means producers keep
 *    re-minting proven-empty task text under fresh ids — queuegen
 *    proposals, router-queue rows, cloud-backlog-discovered items,
 *    restock picks — faster than the dedup that should mark them
 *    DONE-NOOP/CLAIMED can recognize the task_hash identity the gate
 *    uses. `prompt_empty_same_base_24h` or `upkeep_empty_same_base`
 *    recurring means the same class of already-empty work keeps
 *    arriving. The `rebase_*` reasons recurring means the rebase drain
 *    keeps claiming requests whose replacement PR already published,
 *    whose sibling claim never resolves, or whose attempts are
 *    exhausted — the inspect/replace path is not draining them.
 *  - One job id declined again and again: each row is one decline
 *    cycle, and the empty gate never retires the router-queue line
 *    that re-mints it, so a repeat means the same job has been
 *    bouncing off the gate for days — either legitimately waiting on
 *    upstream state, or a job whose queue row nothing will ever
 *    retire.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail — the same ROUTER_OUTCOME_LEDGER_LIMIT
 *    window the router outcome, usage-gap and precheck-park folds read
 *    — nothing is written and no network is touched. A missing or
 *    unreadable file yields no items.
 *  - Rows count only under the jobs-ledger dialect: JSON objects with
 *    a bounded job id (job|job_id|jobId|id), the 'skipped_empty'
 *    lifecycle event across event|type|kind, a timestamp inside the
 *    window — dispatchd writes ts in local wall time with a %z offset,
 *    which parseLedgerTs normalizes. Node-pool producer schemas,
 *    malformed lines and every other event are skipped, never guessed.
 *  - Reason declines only: a skipped_empty row carrying a finite
 *    numeric `code` or `precheck_code` is a precheck decline — the
 *    precheck-skip feed's evidence, claimed by isPrecheckSkipRow — and
 *    an `applied:false` dry-run row records the job still launched,
 *    the same guard every sibling skip-gate reader applies. A row with
 *    neither a numeric code nor a bounded-label reason still counts as
 *    a decline (the event name is the verdict) but folds under
 *    'unrecorded reason' rather than being guessed.
 *  - Recurring means recorded across days: a reason cell emits only at
 *    EMPTY_GATE_MIN_JOBS distinct jobs across EMPTY_GATE_MIN_DAYS
 *    distinct UTC days inside the 7-day window, and a job cell only at
 *    that many recorded decline rows across those days — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply.
 *  - The gate and its writers are pinned ops machinery.
 *    contrib/mac's launch_precheck.py, dispatchd.py and restock.py are
 *    Security-reviewed and re-pinned; agents never edit the live
 *    copies. The ledger rows do carry a repo column, but the decline
 *    decision is this install's machinery serving every repo it runs
 *    — items still emit only when the backlog target's repository name
 *    is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply, and their prompts direct sessions
 *    to fix what this repository owns (the queue producers and dedup
 *    in src/core/queue, the router-queue retirement path, the
 *    detectors that read this evidence) or report no-change naming
 *    pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    recorded reason, or the job id — never the counts or timestamps),
 *    so a refresh re-derives the same id and appendUserBacklogItems
 *    adds only what is new; a cell that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the ledger's
 *    own id shape before they are quoted, reason strings are already
 *    bounded identifier labels, and the brief carries the usual
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

/** Items one call may emit; empty-gate reasons are a small closed vocabulary. */
export const EMPTY_GATE_MAX_ITEMS = 8;
const EMPTY_GATE_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const EMPTY_GATE_WINDOW_HOURS = 168;
/** A reason cell emits only at the fleet's recurring bar of distinct jobs... */
export const EMPTY_GATE_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const EMPTY_GATE_MIN_DAYS = 2;
/** A job cell emits only at the same recurring bar of recorded decline rows... */
export const EMPTY_GATE_MIN_ROWS = 3;
/** Bounded tail of the append-only jobs ledger — the same
 * ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome, usage-gap and
 * precheck-park folds read, so the backlog sees exactly the evidence
 * `phm jobs skipped` and the router outcome fold count; prompts state
 * any truncation as a lower bound.
 */
const EMPTY_GATE_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: empty-gate evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Job ids name log files; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The bounded identifier-label shape the router outcome fold's skip_reason accepts (LEDGER_LABEL in src/core/router/outcomes.ts). */
const SKIP_REASON_LABEL = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/** Reason fields in the router fold's precedence: reason, then empty_reason, then skip_reason, then a string code. */
const SKIP_REASON_KEYS = ['reason', 'empty_reason', 'skip_reason', 'code'] as const;
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

export interface EmptyGateItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default EMPTY_GATE_WINDOW_HOURS). */
  windowHours?: number;
  /** Ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default EMPTY_GATE_MAX_ITEMS, hard-capped). */
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

/** One validated empty-gate skipped_empty row inside the window. */
interface GateRow {
  job: string;
  /** Bounded reason label the row recorded ('unrecorded reason' when none validated). */
  reason: string;
  /** Sanitized lane label ('unknown' when the row carried none). */
  lane: string;
  /** Sanitized repo label ('unattributed' when the row carried none). */
  repo: string;
  atMs: number;
}

/**
 * The row's decline reason in the router fold's own precedence — the
 * first non-empty string among reason|empty_reason|skip_reason|code.
 * A finite numeric code already excluded the row upstream (precheck
 * decline); a string code is the sibling readers' label spelling. The
 * first recorded spelling decides: a present-but-malformed value folds
 * to 'unrecorded reason' rather than falling through to a weaker key.
 */
function gateReason(row: Record<string, unknown>): string {
  let first: string | null = null;
  for (const key of SKIP_REASON_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') { first = value.trim(); break; }
  }
  if (first === null) return 'unrecorded reason';
  return SKIP_REASON_LABEL.test(first) ? first : 'unrecorded reason';
}

/**
 * True when the row is an empty-gate reason decline: the skipped_empty
 * event with no finite numeric gate code (those are precheck declines —
 * isPrecheckSkipRow's claim) and not a dry-run record. The event name
 * alone is the decline verdict; the reason label is evidence detail.
 */
function isEmptyGateSkipRow(row: Record<string, unknown>): boolean {
  if (ledgerEventName(row) !== 'skipped_empty') return false;
  if (row['applied'] === false) return false;
  const code = row['code'];
  if (typeof code === 'number' && Number.isFinite(code)) return false;
  const precheckCode = row['precheck_code'];
  if (typeof precheckCode === 'number' && Number.isFinite(precheckCode)) return false;
  return true;
}

function gateLabel(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return fieldText(value, MAX_NAME_CHARS) || fallback;
}

/**
 * Pure: fold one jobs-ledger tail into validated empty-gate
 * skipped_empty rows. Node-pool producer schemas, malformed JSON,
 * every other event name, precheck-coded declines, dry-run rows,
 * unsafe job ids and rows whose timestamp cannot be placed inside
 * [nowMs - windowMs, nowMs + skew] are skipped, never guessed.
 */
export function foldEmptyGateJournal(
  text: string,
  nowMs: number,
  windowHours: number,
): { rows: GateRow[]; malformed: number } {
  const out: GateRow[] = [];
  let malformed = 0;
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    // Cheap prefilter: decline rows are a minority of the ledger's rows.
    if (!line.includes('skipped_empty')) continue;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!isRecord(row)) { malformed++; continue; }
    if (isNodePoolLedgerRow(row)) continue;
    if (!isEmptyGateSkipRow(row)) continue;
    const job = ledgerJobId(row);
    if (job === null || !SAFE_JOB_ID.test(job)) continue;
    const atMs = ledgerEventTs(row, ledgerPhase(row));
    if (atMs === null || atMs < since || atMs > until) continue;
    const lane = ledgerLane(row);
    out.push({
      job,
      reason: gateReason(row),
      lane: lane === null || lane.trim() === '' ? 'unknown' : fieldText(lane, MAX_NAME_CHARS) || 'unknown',
      repo: gateLabel(row, 'repo', 'unattributed'),
      atMs,
    });
  }
  return { rows: out, malformed };
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface EmptyGateTally {
  /** Sanitized recorded text (a lane or repo label). */
  text: string;
  count: number;
}

/** The two recorded decline shapes; they need different fixes so they never share a cell. */
export type EmptyGateKind = 'reason' | 'job';

/** One emitted decline cell: a recurring reason across jobs, or one repeatedly-declined job. */
export interface EmptyGateCell {
  kind: EmptyGateKind;
  /** reason cells: the recorded reason label, verbatim. */
  reason: string;
  /** job cells: the job id the ledger kept declining. */
  job: string;
  /** reason cells: distinct job ids inside the window; job cells: recorded decline rows. */
  count: number;
  /** Total recorded decline rows folded into the cell. */
  rows: number;
  /** Distinct UTC days the rows landed on. */
  days: string[];
  /** Recorded reasons, most frequent first (job cells mainly). */
  reasons: EmptyGateTally[];
  /** Recorded lane tallies ('unknown' when the ledger named none), most frequent first. */
  lanes: EmptyGateTally[];
  /** Recorded repo tallies ('unattributed' when the ledger named none), most frequent first. */
  repos: EmptyGateTally[];
  /** Up to MAX_EXAMPLES fleet-shaped job ids (reason cells). */
  jobs: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

interface CellAcc {
  kind: EmptyGateKind;
  reason: string;
  job: string;
  rows: number;
  jobs: Set<string>;
  days: Set<string>;
  reasons: Map<string, number>;
  lanes: Map<string, number>;
  repos: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

function newAcc(kind: EmptyGateKind, row: GateRow): CellAcc {
  return {
    kind,
    reason: kind === 'reason' ? row.reason : '',
    job: kind === 'job' ? row.job : '',
    rows: 0,
    jobs: new Set<string>(),
    days: new Set<string>(),
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

function foldRow(acc: CellAcc, row: GateRow): void {
  acc.rows += 1;
  acc.jobs.add(row.job);
  acc.days.add(dayOf(row.atMs));
  bump(acc.reasons, row.reason);
  bump(acc.lanes, row.lane);
  bump(acc.repos, row.repo);
  acc.firstMs = acc.firstMs === null ? row.atMs : Math.min(acc.firstMs, row.atMs);
  acc.lastMs = acc.lastMs === null ? row.atMs : Math.max(acc.lastMs, row.atMs);
}

function tallyOf(map: Map<string, number>, max: number): EmptyGateTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

function toCell(acc: CellAcc, lowerBound: boolean): EmptyGateCell {
  return {
    kind: acc.kind,
    reason: acc.reason,
    job: acc.job,
    count: acc.kind === 'reason' ? acc.jobs.size : acc.rows,
    rows: acc.rows,
    days: [...acc.days].sort(),
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
 * Pure: recurring empty-gate decline cells — a reason recorded on
 * enough distinct jobs across enough distinct UTC days, or one job
 * declined enough recorded times across those days. Sorted by count,
 * the worst decline pressure first.
 */
export function emptyGateCells(rows: readonly GateRow[], lowerBound = false): EmptyGateCell[] {
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
  const cells: EmptyGateCell[] = [];
  for (const acc of reasons.values()) {
    if (acc.jobs.size < EMPTY_GATE_MIN_JOBS || acc.days.size < EMPTY_GATE_MIN_DAYS) continue;
    cells.push(toCell(acc, lowerBound));
  }
  for (const acc of jobs.values()) {
    if (acc.rows < EMPTY_GATE_MIN_ROWS || acc.days.size < EMPTY_GATE_MIN_DAYS) continue;
    cells.push(toCell(acc, lowerBound));
  }
  return cells.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason) || a.job.localeCompare(b.job));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s claim loop and restock\'s pick pass each append one skipped_empty row when launch_precheck.py\'s empty_reason() declines a ready line — job id, repo, lane, the recorded reason and a timestamp, with no numeric code. The router outcome fold records the standing decline per job as skipped/skip_reason, `phm jobs skipped` folds the same rows into its per-job skip table, the empty-finishes readers tally them as skipped finishes, and `phm fleet skip-reasons`/`phm fleet dead-heads` report the queue/skipped-empty.tsv side — none of which turn recurring declines into work. The gate itself is contrib/mac/launch_precheck.py plus contrib/mac/dispatchd.py and contrib/mac/restock.py — pinned, Security-reviewed ops machinery agents never edit live.';

const PINNED_NOTE = ' contrib/mac/launch_precheck.py, contrib/mac/dispatchd.py and contrib/mac/restock.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — preview with contrib/mac/install.sh --dry-run --json and never install over the live pinned copy. Prefer evidence-backed changes in this repository\'s src/ and contrib/ where the cause lives (the queue producers and dedup in src/core/queue, the router-queue retirement path, the detectors that read this evidence), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the declines were a bounded burst the producers recovered from (dedup or restock DONE-NOOP/CLAIMED marking catching up), the gate correctly refused genuinely repeated-empty work, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed dispatcher/precheck/restock files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/**
 * What each recorded reason means in the gate's own vocabulary —
 * the verdict empty_reason() and rebase_retry_reason() returned,
 * quoted from contrib/mac/launch_precheck.py's call sites so the
 * session starts from the producer's semantics rather than guessing.
 * Unknown reasons (a producer's own bounded vocabulary drift) fall
 * back to the recorded label alone.
 */
const REASON_HINTS: Record<string, string> = {
  'upkeep_empty_same_base': 'an RQ-UPKEEP job already finished empty on this exact base — the periodic sweep found nothing to do and the queue re-minted it anyway',
  'prompt_empty_same_base_24h': 'the same prompt on the same base SHA already finished empty inside 24h — the row outlived its usefulness and nothing retired it',
  'task_empty_repeat_24h': 'the same normalized task text already finished empty at least twice inside 24h across any id, lane or base — producers keep re-minting proven-empty work under new ids',
  'rebase_recut_published_inspect_replacement': 'a rebase-drain claim for this request already published its replacement PR — the published verdict stands until inspected',
  'rebase_claim_in_flight_wait_for_finish': 'another claim covering the same rebase request is still in flight — the decline waits for its finish',
  'rebase_retry_exhausted_3x_inspect_claims_change_head_or_task': 'three resolved rebase attempts for this request already failed or finished empty — the drain keeps retrying work that never lands',
};

const tallyText = (tallies: readonly EmptyGateTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: EmptyGateCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: EmptyGateCell): string =>
  cell.lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

function reasonPrompt(cell: EmptyGateCell): string {
  const reason = fieldText(cell.reason, MAX_REASON_CHARS);
  const hint = REASON_HINTS[cell.reason];
  const lanes = cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const examples = cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
  return [
    `Phantom's empty-attempt gate keeps declining queued jobs before launch — ${cell.count} distinct job(s) declined ${cell.rows} recorded time(s) inside the window for reason '${reason}' across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each skipped_empty row is one decline: the empty-attempt gate proved the work already finished empty (or a rebase request hit its retry cap), so the producer's ready line was dropped or skipped and no agent ran.${hint === undefined ? '' : ` Recorded reason meaning: ${hint}.`}${lanes}${repos}${seenText(cell)}${examples}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `A decline is usually the gate working as designed — the question is which producer keeps minting work that already proved empty (queuegen proposals, router-queue rows, cloud-backlog-discovered items, restock picks, issue triage, recut chains), whether the dedup that should mark finished-empty work DONE-NOOP/CLAIMED is missing the task/prompt identity the gate uses, or whether one gate rule now misfires on a whole class of jobs. Find which side owns the cause. If the declines are the machinery correctly refusing repeated-empty work — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function jobPrompt(cell: EmptyGateCell): string {
  const reasons = cell.reasons.length === 0 ? '' : ` Recorded reasons: ${tallyText(cell.reasons)}.`;
  const lanes = cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
  return [
    `Job '${cell.job}' was declined by the empty-attempt gate ${cell.rows} recorded time(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) — the same job id keeps being re-minted and re-declined instead of launching or finishing, the self-improvement work this backlog exists for.`,
    '',
    `Each skipped_empty row is one decline: the empty-attempt gate proved the work already finished empty, so the ready line was dropped or skipped and no agent ran. The gate never retires the router-queue line that re-mints the job, so a repeat means something keeps re-adding it.${reasons}${lanes}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this job never satisfies the gate or never retires: read its queue row and spec (router-queue.md, ready.tsv, the backlog item it came from), check whether the empty evidence the gate cites genuinely exists or is stale, and trace the re-add path — restock refill from router-queue.md READY lines, queuegen dedup, backlog re-discovery, recut chains — for the step that should have marked it DONE-NOOP/CLAIMED or RETIRED. If the job is legitimately waiting on upstream state that keeps changing, or the declines trace to pinned/owner-side causes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    `Fix what lives here — the job spec, its queue row, the producers and dedup this repository owns.${PINNED_NOTE} If the job already finished, was cancelled, or its router-queue line was retired inside the window (the ledger tail only shows the decline rows), report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function emptyGateItem(cell: EmptyGateCell, repo: string): CloudBacklogItem {
  const hashInput = cell.kind === 'reason' ? `empty-gate-reason:${cell.reason}` : `empty-gate-job:${cell.job}`;
  const id = `fleet-empty-gate-${createHash('sha256').update(hashInput).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'reason'
    ? `Empty-attempt gate keeps declining queued jobs: ${fieldText(cell.reason, TITLE_REASON_MAX)}`
    : `Job ${cell.job} keeps being declined by the empty-attempt gate`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'reason' ? reasonPrompt(cell) : jobPrompt(cell),
    area: 'empty-gates',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring empty-gate decline
 * cells. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function emptyGateBacklogItems(opts: EmptyGateItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? EMPTY_GATE_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, EMPTY_GATE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldEmptyGateJournal(tail.text, nowMs, windowHours);
    if (fold.rows.length === 0) return [];
    const cells = emptyGateCells(fold.rows, tail.truncated === true);
    const limit = Math.max(1, Math.min(opts.limit ?? EMPTY_GATE_MAX_ITEMS, EMPTY_GATE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => emptyGateItem(cell, repo));
  } catch {
    return [];
  }
}
