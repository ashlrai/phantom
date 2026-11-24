/**
 * launch-cost.jsonl first-minute resource probe → self-improvement backlog items.
 *
 * contrib/mac/launch_cost.py is the fleet's only per-attempt resource-cost
 * probe: on each launch it samples the job session's process count and CPU
 * for the first minute and appends one `fleet.launch-cost.v1` row to
 * `<runs>/metrics/launch-cost.jsonl` — the only resource-cost evidence
 * subscription lanes record, since their finish rows carry no `cost_usd`.
 * `phm fleet vitals` prints the ledger through
 * src/core/fleet/launch-cost.ts, and src/core/router/outcomes.ts +
 * weight-proposals.ts join it as `launch_cost_*` evidence on every
 * router.outcome.v1 — until now the only readers were those reports and
 * advisory joins, none of which queue work. A probe that never ran, ran
 * but cannot verify a lane's launches, or keeps recording storm-level
 * first-minute figures looked like ordinary absent data: every
 * `launch_cost_*` field simply stayed null.
 *
 * launchCostBacklogItems carries the same journal into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. launch-cost.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail at the vitals reader's own 256 KiB bound;
 *    jobs.jsonl is read once at the router outcome fold's bound for the
 *    launches-in-window gate. Nothing is written and no network is
 *    touched. A missing or unreadable launch-cost file still parses as
 *    zero rows — the silent cell is exactly that evidence.
 *  - Rows count only under the producer's closed contract — the same
 *    validation foldLaunchCosts (src/core/router/outcomes.ts) and
 *    launch-cost.ts apply: exact `fleet.launch-cost.v1` schema, bounded
 *    lane/launchId identifiers, windowSeconds 60, the measured/partial/
 *    unknown status vocabulary, metric figures inside their shapes
 *    (unknown rows carry none, measured rows require nearly-full
 *    60-second coverage with at least 12 samples, mean CPU never
 *    exceeds peak). Malformed lines and off-contract rows are counted,
 *    never guessed.
 *  - Window membership is honest about the producer's only clock. The
 *    row's `startedAt` is the launch's verified start — null on the
 *    early-return `unknown` rows the probe writes when it cannot verify
 *    the launch's claim custody at all. Dated rows window on startedAt
 *    inside the 7-day window (±5-minute future skew, the sibling folds'
 *    clock-drift tolerance). The ledger is append-only, so an undated
 *    row counts as in-window only when it sits after the first
 *    in-window dated row in file order — append order is the ledger's
 *    only chronology for them, and a row written after a known
 *    in-window launch is at least as recent. Undated rows before that
 *    anchor are stale-or-ambiguous and never join a cell; when the file
 *    holds no dated row at all the window cannot open, which is itself
 *    the unverifiable coverage signal below.
 *  - Recurring means recorded across days where dates exist: a cell
 *    emits only at LAUNCH_COST_MIN_ROWS rows across
 *    LAUNCH_COST_MIN_DAYS distinct UTC days of dated evidence — the
 *    fleet's RECURRING_FAILURES convention the sibling feeds apply. A
 *    lane whose non-measured evidence is entirely undated cannot prove
 *    days, so it emits on attempt count instead and the prompt states
 *    the producer records no date for unverifiable launches.
 *  - The silent cell needs launches to mean anything: it emits only
 *    when jobs.jsonl records at least LAUNCH_COST_SILENT_MIN_LAUNCHES
 *    distinct jobs with a launch/launched lifecycle event inside the
 *    window while the launch-cost file yields zero in-window valid
 *    rows — a missing, unreadable, empty, all-malformed or all-stale
 *    ledger alike. A fleet with no recorded launches produces no item:
 *    absent evidence stays absent, never guessed.
 *  - Truncation is stated, never hidden: when either bounded tail cut
 *    older bytes the prompts say the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the probe and its ledger are
 *    this install's dispatcher machinery. Dedup is downstream: the item
 *    id hashes the cell identity, never counts or timestamps, so a
 *    refresh re-derives the same ids and a recovered lane simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerEventName, ledgerJobId } from '../fleet/empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs } from '../fleet/jobs-ledger-dialect.js';
import { ROUTER_LAUNCH_COST_LEDGER_RELATIVE, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE, readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are per-lane plus the silent file-level one. */
export const LAUNCH_COST_BACKLOG_MAX_ITEMS = 8;
const LAUNCH_COST_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const LAUNCH_COST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A cell emits only at the fleet's recurring bar of distinct rows... */
export const LAUNCH_COST_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days of dated evidence. */
export const LAUNCH_COST_MIN_DAYS = 2;
/**
 * The silent cell fires only once the jobs ledger proves real launch
 * activity — the fleet's RECURRING_FAILURES bar applied to launches.
 */
export const LAUNCH_COST_SILENT_MIN_LAUNCHES = 3;
/**
 * Storm bounds for the cost cell — the feed's own policy bar, not a
 * measured baseline: a launch sustaining >=100 session processes or
 * >=800% of one core for a full minute is a process/CPU storm on any
 * host, an order of magnitude past the ~3-process/~125%-CPU shape the
 * probe's own fixture records. Quoted in the prompt as the feed's bar.
 */
export const LAUNCH_COST_PROCESSES_STORM = 100;
export const LAUNCH_COST_CPU_STORM_PCT = 800;
/** Storm rows a cost cell needs inside the window. */
export const LAUNCH_COST_MIN_STORMS = 2;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/**
 * Bounded tail of the append-only launch-cost ledger — the same 256 KiB
 * bound src/core/fleet/launch-cost.ts reads for fleet vitals (the
 * producer itself refuses appends past 1 MiB). jobs.jsonl reads at the
 * router outcome fold's bound so the silent gate sees the same evidence
 * `phm router outcomes` folds; prompts state any truncation as a lower
 * bound.
 */
const LAUNCH_COST_TAIL_BYTES = 256 * 1024;
/** The fleet's own repository label: probe evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Lane ids join in the producer's bounded identifier shape (its private id()). */
const LAUNCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Job ids name log files; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Example launch ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
const MAX_PROMPT_DAYS = 4;

export type LaunchCostStatus = 'measured' | 'partial' | 'unknown';

/** One validated launch-cost row in file order. */
export interface LaunchCostRow {
  /** File position — append order is the ledger's only chronology for undated rows. */
  index: number;
  lane: string;
  launchId: string;
  /** Parsed startedAt in ms; null on the early-return unknown rows (claim custody unverifiable). */
  atMs: number | null;
  status: LaunchCostStatus;
  samples: number;
  peakProcesses: number | null;
  meanCpuPct: number | null;
  peakCpuPct: number | null;
}

export interface LaunchCostItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/launch-cost.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default LAUNCH_COST_WINDOW_MS). */
  windowMs?: number;
  /** Ledger overrides (default: <runsDir>/metrics/{launch-cost,jobs}.jsonl). */
  journalPath?: string;
  jobsPath?: string;
  /** Most items one call emits (default LAUNCH_COST_BACKLOG_MAX_ITEMS, hard-capped). */
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

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const LAUNCH_COST_COUNT = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const LAUNCH_COST_STATUSES: ReadonlySet<string> = new Set(['measured', 'partial', 'unknown']);

/**
 * Pure: parse one journal line into a validated row under the producer's
 * closed contract — the same checks foldLaunchCosts and launch-cost.ts
 * apply, plus the lane, launchId, startedAt and samples the backlog
 * cells need. Anything else is not a journal row.
 */
export function parseLaunchCostRow(value: unknown, index: number): LaunchCostRow | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== 'fleet.launch-cost.v1') return null;
  const lane = value['lane'];
  const launchId = value['launchId'];
  if (typeof lane !== 'string' || !LAUNCH_ID.test(lane)) return null;
  if (typeof launchId !== 'string' || !LAUNCH_ID.test(launchId)) return null;
  const startedAt = value['startedAt'];
  const atMs = startedAt === null ? null
    : typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : NaN;
  if (atMs !== null && !Number.isFinite(atMs)) return null;
  if (value['windowSeconds'] !== 60) return null;
  const sampledSeconds = value['sampledSeconds'];
  if (!LAUNCH_COST_COUNT(sampledSeconds) || sampledSeconds > 60) return null;
  const samples = value['samples'];
  if (!Number.isSafeInteger(samples) || (samples as number) < 0) return null;
  const status = value['status'];
  if (typeof status !== 'string' || !LAUNCH_COST_STATUSES.has(status)) return null;
  const metrics = [value['peakProcesses'], value['meanCpuPercentOneCore'], value['peakCpuPercentOneCore']];
  if (metrics.some((v) => v !== null && !LAUNCH_COST_COUNT(v))) return null;
  const peakProcesses = value['peakProcesses'];
  if (peakProcesses !== null && !Number.isSafeInteger(peakProcesses)) return null;
  const meanCpu = value['meanCpuPercentOneCore'];
  const peakCpu = value['peakCpuPercentOneCore'];
  if (status === 'unknown' && metrics.some((v) => v !== null)) return null;
  if (status !== 'unknown' && (atMs === null || metrics.some((v) => v === null) || (samples as number) < 1 || (peakProcesses as number) < 1)) return null;
  if (status === 'measured' && (sampledSeconds < 59 || (samples as number) < 12)) return null;
  if (LAUNCH_COST_COUNT(meanCpu) && LAUNCH_COST_COUNT(peakCpu) && meanCpu > peakCpu) return null;
  return {
    index,
    lane,
    launchId,
    atMs,
    status: status as LaunchCostStatus,
    samples: samples as number,
    peakProcesses: peakProcesses === null ? null : peakProcesses as number,
    meanCpuPct: meanCpu === null ? null : meanCpu as number,
    peakCpuPct: peakCpu === null ? null : peakCpu as number,
  };
}

/**
 * Pure: parse journal text into validated rows in file order plus the
 * count of non-blank lines that were not on-contract records.
 */
export function parseLaunchCostJournal(text: string): { rows: LaunchCostRow[]; invalidRows: number } {
  const rows: LaunchCostRow[] = [];
  let invalidRows = 0;
  let index = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      index += 1;
      continue;
    }
    const row = parseLaunchCostRow(value, index);
    index += 1;
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Window membership — dated rows on startedAt, undated rows by append order
// ---------------------------------------------------------------------------

/**
 * Pure: split validated rows into in-window and out-of-window under the
 * honesty rule the header documents. Dated rows window on startedAt;
 * undated rows count only after the first in-window dated row opens the
 * window (append order is the ledger's chronology for them). Returns the
 * in-window rows plus counts of dated-outside, undated-before-anchor and
 * undated-with-no-anchor rows for the prompts' honesty notes.
 */
export function windowLaunchCostRows(
  rows: readonly LaunchCostRow[],
  nowMs: number,
  windowMs: number,
): { inWindow: LaunchCostRow[]; datedOutside: number; undatedBeforeAnchor: number; undatedNoAnchor: number; datedInWindow: number; allUndated: boolean } {
  const windowStart = nowMs - windowMs;
  const until = nowMs + SKEW_MS;
  const datedFlags = rows.map((row) => row.atMs !== null && row.atMs >= windowStart && row.atMs <= until);
  const firstAnchor = datedFlags.indexOf(true);
  const inWindow: LaunchCostRow[] = [];
  let datedOutside = 0;
  let undatedBeforeAnchor = 0;
  let undatedNoAnchor = 0;
  let datedInWindow = 0;
  rows.forEach((row, i) => {
    if (row.atMs !== null) {
      if (datedFlags[i]) { inWindow.push(row); datedInWindow += 1; }
      else datedOutside += 1;
      return;
    }
    if (firstAnchor === -1) { undatedNoAnchor += 1; return; }
    if (i > firstAnchor) inWindow.push(row);
    else undatedBeforeAnchor += 1;
  });
  // A file with rows but not one dated row is the probe-blind case: the
  // window cannot open on startedAt, so every row joins as undated
  // evidence — attempt-count recurrence, days unrecorded, and the
  // prompts say so. A file whose dated rows are all stale keeps its
  // undated rows out: interleaved with old dated evidence they are
  // old-or-ambiguous, never guessed recent.
  const allUndated = datedInWindow === 0 && datedOutside === 0 && rows.length > 0;
  if (allUndated) {
    return { inWindow: [...rows], datedOutside, undatedBeforeAnchor, undatedNoAnchor: 0, datedInWindow, allUndated };
  }
  return { inWindow, datedOutside, undatedBeforeAnchor, undatedNoAnchor, datedInWindow, allUndated };
}

// ---------------------------------------------------------------------------
// jobs.jsonl — the launches-in-window gate for the silent cell
// ---------------------------------------------------------------------------

const LAUNCH_EVENTS: ReadonlySet<string> = new Set(['launch', 'launched']);

/**
 * Pure: count distinct job ids whose newest launch/lauched lifecycle row
 * lands inside the window — the silent cell's "the fleet launched work"
 * proof. Rows outside the jobs-ledger dialect (node-pool producers,
 * malformed lines, non-launch events) never count.
 */
export function countWindowLaunches(
  text: string,
  nowMs: number,
  windowMs: number,
): { launches: number; jobs: Set<string> } {
  const jobs = new Set<string>();
  const windowStart = nowMs - windowMs;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Cheap prefilter: launch rows are a minority of the ledger's rows.
    if (!line.includes('launch')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row)) continue;
    if (isNodePoolLedgerRow(row)) continue;
    const event = ledgerEventName(row);
    if (event === null || !LAUNCH_EVENTS.has(event)) continue;
    const job = ledgerJobId(row);
    if (job === null || !SAFE_JOB_ID.test(job)) continue;
    const atMs = ledgerEventTs(row, null);
    if (atMs === null || atMs < windowStart || atMs > until) continue;
    jobs.add(job);
  }
  return { launches: jobs.size, jobs };
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One emitted cell: silent (file-level) or per-lane coverage/cost. */
export interface LaunchCostCell {
  kind: 'silent' | 'coverage' | 'cost';
  /** Per-lane cells carry the recorded lane; silent carries 'fleet'. */
  lane: string;
  /** In-window rows behind the cell (silent: launches counted instead). */
  rows: number;
  /** Distinct UTC days of dated evidence; empty when the cell's evidence is entirely undated. */
  days: string[];
  /** For coverage: the lane's non-measured row count (unknown+partial). For cost: storm rows. */
  adverse: number;
  /** For cost: the lane's recorded maxima quoted in the prompt. */
  maxPeakProcesses: number | null;
  maxPeakCpuPct: number | null;
  /** For silent: launches recorded in the jobs window. */
  launches: number;
  /** Example launchIds quoted inside one prompt. */
  examples: string[];
  /** True when either bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
  /** True when the cell's dated evidence could not prove day recurrence (undated-dominated). */
  undatedRecurrence: boolean;
}

interface LaneFold {
  lane: string;
  /** Distinct UTC days of the lane's dated in-window rows. */
  days: Set<string>;
  nonMeasuredRows: LaunchCostRow[];
  stormRows: LaunchCostRow[];
  maxPeakProcesses: number | null;
  maxPeakCpuPct: number | null;
}

function blankLane(lane: string): LaneFold {
  return { lane, days: new Set(), nonMeasuredRows: [], stormRows: [], maxPeakProcesses: null, maxPeakCpuPct: null };
}

function isStorm(row: LaunchCostRow): boolean {
  return (row.peakProcesses !== null && row.peakProcesses >= LAUNCH_COST_PROCESSES_STORM) ||
    (row.peakCpuPct !== null && row.peakCpuPct >= LAUNCH_COST_CPU_STORM_PCT);
}

/**
 * Pure: fold in-window rows into per-lane coverage and cost cells at the
 * recurring bars. Coverage counts non-measured rows (unknown + partial —
 * the probe ran but did not fully measure); cost counts storm rows among
 * measured launches. A lane whose non-measured evidence is entirely
 * undated emits on attempt count (LAUNCH_COST_MIN_ROWS * 2) with
 * undatedRecurrence set — the producer records no date for launches it
 * cannot verify, so day recurrence is unprovable and the prompt says so.
 */
export function launchCostCells(
  rows: readonly LaunchCostRow[],
  opts: { launches: number; lowerBound?: boolean },
): LaunchCostCell[] {
  const cells: LaunchCostCell[] = [];
  if (opts.launches >= LAUNCH_COST_SILENT_MIN_LAUNCHES && rows.length === 0) {
    cells.push({
      kind: 'silent', lane: 'fleet', rows: 0, days: [], adverse: 0,
      maxPeakProcesses: null, maxPeakCpuPct: null, launches: opts.launches,
      examples: [], lowerBound: opts.lowerBound === true, undatedRecurrence: false,
    });
  }
  const lanes = new Map<string, LaneFold>();
  for (const row of rows) {
    let lane = lanes.get(row.lane);
    if (lane === undefined) { lane = blankLane(row.lane); lanes.set(row.lane, lane); }
    if (row.atMs !== null) lane.days.add(dayOf(row.atMs));
    if (row.status !== 'measured') lane.nonMeasuredRows.push(row);
    if (row.status === 'measured' && isStorm(row)) lane.stormRows.push(row);
    if (row.peakProcesses !== null) lane.maxPeakProcesses = Math.max(lane.maxPeakProcesses ?? 0, row.peakProcesses);
    if (row.peakCpuPct !== null) lane.maxPeakCpuPct = Math.max(lane.maxPeakCpuPct ?? 0, row.peakCpuPct);
  }
  for (const lane of lanes.values()) {
    const nonMeasured = lane.nonMeasuredRows.length;
    const coverageDaysList = [...new Set(
      lane.nonMeasuredRows.filter((r) => r.atMs !== null).map((r) => dayOf(r.atMs as number)),
    )].sort();
    const undatedOnly = nonMeasured > 0 && lane.nonMeasuredRows.every((r) => r.atMs === null);
    if (nonMeasured >= LAUNCH_COST_MIN_ROWS &&
        (coverageDaysList.length >= LAUNCH_COST_MIN_DAYS || (undatedOnly && nonMeasured >= LAUNCH_COST_MIN_ROWS * 2))) {
      cells.push({
        kind: 'coverage', lane: lane.lane, rows: nonMeasured, days: coverageDaysList,
        adverse: nonMeasured, maxPeakProcesses: null, maxPeakCpuPct: null,
        launches: 0, examples: lane.nonMeasuredRows.slice(0, MAX_EXAMPLES).map((r) => r.launchId),
        lowerBound: opts.lowerBound === true, undatedRecurrence: undatedOnly,
      });
    }
    const storms = lane.stormRows.length;
    if (storms >= LAUNCH_COST_MIN_STORMS && lane.days.size >= LAUNCH_COST_MIN_DAYS) {
      cells.push({
        kind: 'cost', lane: lane.lane, rows: storms, days: [...lane.days].sort(),
        adverse: storms, maxPeakProcesses: lane.maxPeakProcesses, maxPeakCpuPct: lane.maxPeakCpuPct,
        launches: 0, examples: lane.stormRows.slice(0, MAX_EXAMPLES).map((r) => r.launchId),
        lowerBound: opts.lowerBound === true, undatedRecurrence: false,
      });
    }
  }
  return cells.sort((a, b) => b.rows - a.rows || a.lane.localeCompare(b.lane));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/launch-cost.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): contrib/mac/launch_cost.py\'s first-minute ps probe appends one fleet.launch-cost.v1 row per launch attempt — lane, launchId (<job> or <job>-<12hex claim hash>), startedAt, sampledSeconds/samples, peakProcesses, mean/peak CPU percent of one core and status (measured / partial / unknown). The producer caps the file at 1 MiB; readers take a bounded tail. `phm fleet vitals` prints it through src/core/fleet/launch-cost.ts, and src/core/router/outcomes.ts + weight-proposals.ts join it as launch_cost_* evidence on every router.outcome.v1 — the only per-attempt resource-cost evidence subscription lanes record, since their finish rows carry no cost_usd. Until this feed none of those readers queued work — a dead, blind or storming probe looked like ordinary absent data.';

const PINNED_NOTE = ' contrib/mac/launch_cost.py and the dispatcher that would invoke it are pinned machinery: a fix there needs Security review and re-pin before install — preview with contrib/mac/install.sh --dry-run --json and never install over the live pinned copy. Prefer evidence-backed changes in this repository\'s src/ where the cause lives (the ledger readers, the router outcome and weight folds, the vitals report), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the probe was a transitional gap the fleet recovered from, the lane legitimately launches too rarely for the probe to measure, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundText = (cell: LaunchCostCell): string =>
  cell.lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const examplesText = (cell: LaunchCostCell): string =>
  cell.examples.length === 0 ? '' : ` Example launch ids: ${cell.examples.join(', ')}.`;

function silentPrompt(cell: LaunchCostCell): string {
  return [
    `Phantom's fleet launched ${cell.launches} job(s) inside the window but metrics/launch-cost.jsonl yielded zero valid fleet.launch-cost.v1 rows inside the same window — the first-minute resource probe produced no current evidence at all, the self-improvement work this backlog exists for.`,
    '',
    `contrib/mac/launch_cost.py exists, is tested and is documented as the producer of this ledger, but nothing in the launch path invokes it: no dispatcher hook, no fleet manifest entry, no scheduled caller. Every launch_cost_* field in \`phm router outcomes\` and \`phm fleet router-weights\` therefore stays null — unknown, never a guessed resource figure — and subscription lanes lose their only per-attempt resource-cost signal. If the file holds only stale rows the probe ran once and stopped; if it is missing or empty it never ran at all — the report should say which.${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why the probe never ran or stopped: check whether contrib/mac/launch_cost.py is installed beside the dispatcher (~/.ashlr-runs/bin), whether dispatchd's launch path was meant to invoke it post-launch, and whether the fleet manifest or install flow dropped it. The fix likely lives in pinned contrib/mac machinery — name the exact hook point for the owner rather than working around it.`,
    '',
    `If the probe was deliberately retired, the readers are stale rather than the producer missing — say which in the report. ${PINNED_NOTE} ${NO_CHANGE}`,
  ].join('\n');
}

function coveragePrompt(cell: LaunchCostCell): string {
  const days = cell.days.length === 0 ? '' : ` across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;
  const recurrence = cell.undatedRecurrence
    ? ' The producer records no startedAt for launches it cannot verify, so these rows carry no date — recurrence is by attempt count, not calendar days.'
    : '';
  return [
    `Phantom's launch-cost probe keeps failing to measure lane '${fieldText(cell.lane, MAX_NAME_CHARS)}' — ${cell.adverse} in-window row(s) recorded status 'unknown' or 'partial'${days}, the self-improvement work this backlog exists for.`,
    '',
    `'unknown' means the probe ran but recorded nothing — the launch's claim custody could not be verified (no claim row, failed verify_current_claim, a non-ps-lstart start source) or it attached yet saw no known-state samples. 'partial' means it attached but coverage was incomplete — a late attach, fewer than 12 samples, or a clipped window. Either way the lane's launches produce no usable first-minute resource evidence.${recurrence}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which launches the probe cannot see: reproduce with \`phm fleet vitals\` (the launchCost section) and \`phm router outcomes --json\` (the launch_cost_* fields), then check whether this lane's launches carry the claim fields the probe requires (startSource 'ps-lstart', a verifiable claim row), whether the lane launches through a path the probe was never meant to cover (node pool, batch members, relaunches), and whether the probe attaches too late for short-lived sessions.`,
    '',
    `Fix what lives here — the ledger readers and router folds in src/, or document the pinned-side cause for the owner.${PINNED_NOTE} ${NO_CHANGE}`,
  ].join('\n');
}

function costPrompt(cell: LaunchCostCell): string {
  const processes = cell.maxPeakProcesses === null ? 'unknown' : String(cell.maxPeakProcesses);
  const cpu = cell.maxPeakCpuPct === null ? 'unknown' : `${cell.maxPeakCpuPct}% of one core`;
  return [
    `Phantom's launch-cost probe keeps recording storm-level first-minute resource use on lane '${fieldText(cell.lane, MAX_NAME_CHARS)}' — ${cell.adverse} measured launch(es) inside the window crossed the feed's storm bar (>=${LAUNCH_COST_PROCESSES_STORM} session processes or >=${LAUNCH_COST_CPU_STORM_PCT}% of one core for the full minute), the self-improvement work this backlog exists for.`,
    '',
    `Recorded maxima on the lane's measured rows: peak processes ${processes}, peak CPU ${cpu}. A launch sustaining that for a full minute is a process or CPU storm — the host's memory gate, swap and lane admission all feel it, and on a shared machine it starves sibling lanes.${examplesText(cell)} across ${cell.days.length} UTC day(s) (${daysText(cell.days)}).${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find what the storming launches share: reproduce with \`phm fleet vitals\` (the launchCost section) and \`phm router outcomes --json\` (launch_peak_processes / launch_peak_cpu_pct), then check whether the lane's agent spawns runaway children at startup (MCP servers, watchers, build steps), whether a specific job shape or repo triggers it, and whether host memory pressure correlates — the swapout-rate and fleet-controller ledgers carry the same window.`,
    '',
    `Fix what lives here — the launch path or job shape this repository owns; a lane-side or pinned-dispatcher cause gets documented for the owner.${PINNED_NOTE} ${NO_CHANGE}`,
  ].join('\n');
}

function launchCostItem(cell: LaunchCostCell, repo: string): CloudBacklogItem {
  const lane = fieldText(cell.lane, MAX_NAME_CHARS);
  const title = cell.kind === 'silent'
    ? 'Launch-cost probe produced no evidence despite recorded launches'
    : cell.kind === 'coverage'
      ? `Launch-cost probe cannot measure lane '${lane}' launches`
      : `Launch-cost probe records storm-level launches on lane '${lane}'`;
  return {
    id: `launch-cost-${sha(`launch-cost:${cell.kind}:${cell.lane}`)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'silent' ? silentPrompt(cell) : cell.kind === 'coverage' ? coveragePrompt(cell) : costPrompt(cell),
    area: 'launch-cost',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the launch-cost probe journal's silent, coverage and
 * storm cells. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function launchCostBacklogItems(opts: LaunchCostItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? LAUNCH_COST_WINDOW_MS;
    const costPath = opts.journalPath ?? join(runsDir, ROUTER_LAUNCH_COST_LEDGER_RELATIVE);
    const jobsPath = opts.jobsPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const [costRead, jobsRead] = await Promise.all([
      readLedgerTail(costPath, LAUNCH_COST_TAIL_BYTES),
      readLedgerTail(jobsPath, ROUTER_OUTCOME_LEDGER_LIMIT),
    ]);
    const parsed = costRead.state === 'read' ? parseLaunchCostJournal(costRead.text) : { rows: [], invalidRows: 0 };
    const windowed = windowLaunchCostRows(parsed.rows, nowMs, windowMs);
    const launches = jobsRead.state === 'read' ? countWindowLaunches(jobsRead.text, nowMs, windowMs).launches : 0;
    const lowerBound = (costRead.state === 'read' && costRead.truncated === true) || (jobsRead.state === 'read' && jobsRead.truncated === true);
    const cells = launchCostCells(windowed.inWindow, { launches, lowerBound });
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? LAUNCH_COST_BACKLOG_MAX_ITEMS, LAUNCH_COST_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => launchCostItem(cell, repo));
  } catch {
    return [];
  }
}
