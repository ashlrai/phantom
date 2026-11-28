/**
 * Host disk-sweep journal recurring adverse evidence → self-improvement
 * backlog items.
 *
 * `phm fleet disk-sweep` (src/cli/fleet-disk-sweep.ts) is the one command
 * a host timer can run to relieve disk pressure before it reaches the
 * lane-freeze line: when free disk reads under
 * `compact.lanes.raise_freeze_below_gb` (or --force, or the reading is
 * unreadable) it runs `fleet wt-cache` then `fleet worktree-stale`
 * in-process and prints one line per step with the GB freed. Add --log
 * and each run appends one JSON row — {generatedAt, apply, freeGb,
 * swept, freedGb, steps:[{name, ran, code, freedGb}]} — to
 * queue/disk-sweep.jsonl under the fleet runs directory; --history [N]
 * prints the tail back. Until now the journal's only reader was that
 * --history flag — a report someone had to run and read — so a sweep
 * step that kept exiting non-zero, or applied sweeps that kept
 * reclaiming nothing while the disk stayed under the freeze line,
 * sat in an append-only file nobody folded, never work. The sibling
 * disk-backlog fold covers the pressure itself (the sample files'
 * below-freeze and freeze-runway hours); this feed covers the
 * mitigation's own outcomes — the evidence that the machinery built
 * to relieve the pressure is failing or finding nothing to reclaim.
 *
 * diskSweepBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling disk source beside it.
 *
 * Two evidence axes, both anchored to the writer's own row contract:
 *   - step failures: a swept row whose wt-cache or worktree-stale step
 *     ran and exited non-zero — the sweep tried its remediation and
 *     the step itself failed (scan error, removal error, bad usage).
 *   - zero-yield sweeps: an applied, swept row under the freeze line
 *     whose recorded freedGb is zero — the sweep ran for real and
 *     reclaimed nothing measurable while pressure existed. Dry-run
 *     rows never join this axis: the writer measures worktree-stale's
 *     yield only on --apply, so a dry run's freedGb is a partial
 *     estimate, not a yield.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read (256 KiB); rows are validated against
 *    the writer's logged shape — parseable generatedAt, boolean
 *    apply/swept, freeGb a non-negative number or null, freedGb a
 *    non-negative number, and steps drawn from the writer's closed
 *    {wt-cache, worktree-stale} vocabulary with the ran/code pairing
 *    the writer guarantees (ran steps carry an exit code, unrun steps
 *    carry null). Malformed lines and off-contract rows count as
 *    invalidRows, never guessed; nothing is written and no process is
 *    inspected.
 *  - Missing or unreadable evidence yields no items. A missing,
 *    non-file or unreadable journal is the writer's normal state —
 *    the --log flag is opt-in and a host without the timer never
 *    writes one — and contributes nothing rather than an error.
 *  - Recurring means recorded, on the fold's own bars. An axis emits
 *    only while at least DISK_SWEEP_MIN_ROWS adverse rows inside the
 *    window span at least DISK_SWEEP_MIN_DAYS distinct UTC days — one
 *    failed sweep is an incident, not a pattern. Rows dated outside
 *    the window or beyond the 60-second future-skew tolerance are
 *    counted as outsideWindow, never evidence either way.
 *  - Pressure is judged against the live freeze line. The logged row
 *    does not carry freezeBelowGb, so the zero-yield axis compares
 *    each row's recorded freeGb to readFreezeLine's current value —
 *    the same re-anchoring the sibling disk fold applies, where a
 *    config change re-judges history the way the report would. A row
 *    whose freeGb is null (the sweep ran blind) or at/above the line
 *    cannot prove pressure and never joins the yield axis; it still
 *    counts toward step failures, which are pressure-independent.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Both ids are stable strings, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; shifted tallies do not spawn twin items and a quiet
 *    window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the freeze line and its config source
 *    ride in the evidence, and the brief names the journal, the two
 *    step commands, `phm fleet disk-sweep --history`, `phm host disk`
 *    and the sibling disk items — with the usual no-change escape
 *    when the window no longer reproduces or the cause is owner-side.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readFreezeLine } from '../fleet/host-disk.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit: at most one per evidence axis. */
export const DISK_SWEEP_MAX_ITEMS = 2;
const DISK_SWEEP_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the friction,
 * autofix, tick-health and sibling disk sources apply. The journal is
 * opt-in (--log) and a host timer writes at most a few rows a day, so
 * the retained tail covers the window many times over.
 */
export const DISK_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
export const DISK_SWEEP_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail of the journal. Rows run a few hundred bytes, so 256 KiB
 * covers well over a thousand sweep runs — far past a week of even an
 * hourly timer; a contract-violating larger file still folds its
 * newest rows flagged as a lower bound.
 */
export const DISK_SWEEP_TAIL_BYTES = 256 * 1024;
/** Adverse rows an axis needs inside the window before it counts as recurring. */
export const DISK_SWEEP_MIN_ROWS = 3;
/** Those rows must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const DISK_SWEEP_MIN_DAYS = 2;
/**
 * freedGb at or under this records a sweep that reclaimed nothing
 * measurable. The writer round1()s every yield, so 0 is the recorded
 * zero — sub-0.1 GB reclaims round away and never prove relief.
 */
export const DISK_SWEEP_ZERO_YIELD_GB = 0;
/** The writer's closed step vocabulary (fleet-disk-sweep.ts's plan list). */
const STEP_VOCABULARY = new Set(['wt-cache', 'worktree-stale']);
/** The fleet's own repository label: sweep evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;

export interface DiskSweepItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/disk-sweep.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default DISK_SWEEP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default DISK_SWEEP_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated step outcome inside a journaled sweep row. */
export interface DiskSweepStep {
  /** The writer's closed step name. */
  name: string;
  /** Whether the step ran (false only on unswept rows). */
  ran: boolean;
  /** Process exit code when ran; null exactly when the step did not run. */
  code: number | null;
  /** GB the step recorded freeing (dry-run estimates for wt-cache). */
  freedGb: number;
}

/** One validated disk-sweep.jsonl row: a sweep run's recorded outcome. */
export interface DiskSweepRow {
  atMs: number;
  utcDay: string;
  /** Whether the run was --apply; dry runs estimate wt-cache yield only. */
  apply: boolean;
  /** Whether the run swept (below the freeze line, --force, or unreadable free space). */
  swept: boolean;
  /** Free GB recorded before the sweep; null when statfs could not read it. */
  freeGb: number | null;
  /** Total GB the steps recorded freeing, round1'd by the writer. */
  freedGb: number;
  steps: DiskSweepStep[];
}

/** Per-axis recurrence tally: adverse rows, the UTC days they span, and their recorded time bounds. */
export interface DiskSweepAxisEvidence {
  /** In-window adverse rows on this axis. */
  rows: number;
  /** Distinct UTC days those rows fall on. */
  days: Set<string>;
  /** ISO bounds of the axis's rows; null when none recorded a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Journal coverage the prompts state: what the bounded read actually saw. */
export interface DiskSweepCoverage {
  /** Lines that were not on-contract records — malformed JSON plus off-contract rows. */
  invalidRows: number;
  /** True when the bounded tail cut older rows: counts are a lower bound. */
  truncated: boolean;
  /** The ledger read's own state when it was not 'read'. */
  sourceState: string;
}

/** The fold's measured evidence; every count is over in-window rows only. */
export interface DiskSweepEvidence {
  /** Valid journaled rows inside the window. */
  rows: number;
  /** Valid rows dated outside the window or beyond the future-skew tolerance; not evidence either way. */
  outsideWindow: number;
  /** In-window rows that were --apply vs dry runs. */
  appliedRows: number;
  dryRunRows: number;
  /** In-window rows that did not sweep (disk at/above the line, no --force). */
  unsweptRows: number;
  /** In-window swept rows whose freeGb was null — the sweep ran without a disk reading. */
  unmeasuredSweeps: number;
  /** In-window rows recording freeGb under the live freeze line. */
  pressuredRows: number;
  /** The freeze line the yield axis judged against and which config layer supplied it. */
  freezeBelowGb: number;
  freezeSource: string;
  /** Rows with at least one ran step exiting non-zero, plus the per-step failing-row tally. */
  stepFailures: DiskSweepAxisEvidence;
  failingSteps: Array<{ name: string; count: number }>;
  /** Applied, swept, pressured rows recording freedGb <= DISK_SWEEP_ZERO_YIELD_GB. */
  zeroYield: DiskSweepAxisEvidence;
  /** Denominator for the yield axis: applied, swept, pressured rows of any yield. */
  pressuredAppliedSweeps: number;
  oldestAt: string | null;
  newestAt: string | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A non-negative finite number, the shape every recorded GB figure takes. */
function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Pure: validate one parsed disk-sweep.jsonl line against the shape the
 * writer's --log appendFile emits — {generatedAt, apply, freeGb, swept,
 * freedGb, steps}. Steps must come from the writer's closed vocabulary
 * and keep its ran/code pairing: a ran step carries a finite exit code,
 * an unrun step carries null. Anything else is not a journal row.
 */
export function parseDiskSweepEntry(value: unknown): DiskSweepRow | null {
  if (!isRecord(value)) return null;
  const generatedAt = value['generatedAt'];
  const atMs = typeof generatedAt === 'string' ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const apply = value['apply'];
  const swept = value['swept'];
  if (typeof apply !== 'boolean' || typeof swept !== 'boolean') return null;
  const freeGb = value['freeGb'];
  if (freeGb !== null && !nonNegative(freeGb)) return null;
  const freedGb = value['freedGb'];
  if (!nonNegative(freedGb)) return null;
  const rawSteps = value['steps'];
  // The writer always logs both plan steps; an empty list cannot prove
  // a swept row ran anything and would vacuously satisfy the yield
  // axis's every-step-ran check.
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  const steps: DiskSweepStep[] = [];
  for (const raw of rawSteps) {
    if (!isRecord(raw)) return null;
    const name = raw['name'];
    if (typeof name !== 'string' || !STEP_VOCABULARY.has(name)) return null;
    const ran = raw['ran'];
    if (typeof ran !== 'boolean') return null;
    const code = raw['code'];
    const stepFreed = raw['freedGb'];
    if (!nonNegative(stepFreed)) return null;
    if (ran) {
      if (typeof code !== 'number' || !Number.isFinite(code)) return null;
    } else if (code !== null) return null;
    steps.push({ name, ran, code: ran ? (code as number) : null, freedGb: stepFreed });
  }
  return { atMs, utcDay: utcDayOf(atMs), apply, swept, freeGb: freeGb as number | null, freedGb, steps };
}

/**
 * Pure: parse one disk-sweep.jsonl file's text into validated rows plus
 * the count of lines that were not on-contract records — malformed JSON
 * and off-contract rows are counted, never guessed.
 */
export function parseDiskSweepJournal(text: string): { rows: DiskSweepRow[]; invalidRows: number } {
  const rows: DiskSweepRow[] = [];
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
    const row = parseDiskSweepEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

interface AxisTally {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
}

const newTally = (): AxisTally => ({ rows: 0, days: new Set(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY });

function bumpTally(tally: AxisTally, row: DiskSweepRow): void {
  tally.rows += 1;
  tally.days.add(row.utcDay);
  tally.firstMs = Math.min(tally.firstMs, row.atMs);
  tally.lastMs = Math.max(tally.lastMs, row.atMs);
}

function axisEvidence(tally: AxisTally): DiskSweepAxisEvidence {
  return {
    rows: tally.rows,
    days: tally.days,
    firstSeen: tally.rows === 0 ? null : new Date(tally.firstMs).toISOString(),
    lastSeen: tally.rows === 0 ? null : new Date(tally.lastMs).toISOString(),
  };
}

/**
 * Pure: fold validated journal rows into the sweep evidence. Rows
 * outside the window or beyond the future-skew tolerance never join a
 * tally; valid out-of-window rows count as outsideWindow. The yield
 * axis judges each row's recorded freeGb against the supplied freeze
 * line — the live-config value the caller resolved — so a config
 * change re-anchors history the way the sweep's own trigger would
 * have.
 */
export function foldDiskSweepEvidence(
  rows: readonly DiskSweepRow[],
  opts: { nowMs: number; freezeBelowGb: number; freezeSource?: string; windowMs?: number },
): DiskSweepEvidence {
  const windowMs = opts.windowMs ?? DISK_SWEEP_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const freezeBelowGb = opts.freezeBelowGb;
  let inWindowRows = 0;
  let outsideWindow = 0;
  let appliedRows = 0;
  let dryRunRows = 0;
  let unsweptRows = 0;
  let unmeasuredSweeps = 0;
  let pressuredRows = 0;
  let pressuredAppliedSweeps = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  const stepFailures = newTally();
  const zeroYield = newTally();
  const failingCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + DISK_SWEEP_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindowRows += 1;
    oldestMs = Math.min(oldestMs, row.atMs);
    newestMs = Math.max(newestMs, row.atMs);
    if (row.apply) appliedRows += 1; else dryRunRows += 1;
    if (!row.swept) { unsweptRows += 1; continue; }
    if (row.freeGb === null) unmeasuredSweeps += 1;
    else if (row.freeGb < freezeBelowGb) pressuredRows += 1;
    const failing = row.steps.filter((step) => step.ran && step.code !== 0);
    if (failing.length > 0) {
      bumpTally(stepFailures, row);
      for (const step of failing) failingCounts.set(step.name, (failingCounts.get(step.name) ?? 0) + 1);
    }
    // The yield axis needs an applied sweep that provably ran under
    // pressure: freeGb recorded under the live freeze line, every step
    // ran (the writer's swept-row invariant), and the recorded total
    // freed nothing measurable. Dry runs and blind (null freeGb) rows
    // cannot prove either half.
    const pressured = row.apply && row.swept && row.freeGb !== null && row.freeGb < freezeBelowGb;
    if (pressured) {
      pressuredAppliedSweeps += 1;
      if (row.freedGb <= DISK_SWEEP_ZERO_YIELD_GB && row.steps.every((step) => step.ran)) {
        bumpTally(zeroYield, row);
      }
    }
  }
  return {
    rows: inWindowRows, outsideWindow,
    appliedRows, dryRunRows, unsweptRows, unmeasuredSweeps, pressuredRows,
    freezeBelowGb, freezeSource: opts.freezeSource ?? 'default',
    stepFailures: axisEvidence(stepFailures),
    failingSteps: [...failingCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    zeroYield: axisEvidence(zeroYield),
    pressuredAppliedSweeps,
    oldestAt: inWindowRows === 0 ? null : new Date(oldestMs).toISOString(),
    newestAt: inWindowRows === 0 ? null : new Date(newestMs).toISOString(),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const NO_CHANGE = 'If the window has rolled forward, the failures or empty sweeps were a one-off burst the next runs recovered from, the host timer was retuned or removed, or the cause is owner-side or pinned ops machinery (credentials, billing, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin, host state outside this repository, or consumption the sweep was never built to reclaim) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the file, its writer and its existing reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/disk-sweep.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — one {generatedAt, apply, freeGb, swept, freedGb, steps} row per `phm fleet disk-sweep --log` run (src/cli/fleet-disk-sweep.ts), appended when a host timer invokes the sweep. Its only reader until now was the same command\'s --history flag; this feed is the first recurrence fold. The sweep triggers when free disk reads under compact.lanes.raise_freeze_below_gb — the freeze line readFreezeLine resolves from the fleet\'s layered config, the same source `phm host disk` and the sibling disk-backlog items judge against.';

function spanText(ev: DiskSweepEvidence): string {
  if (ev.oldestAt === null || ev.newestAt === null) return '';
  return ev.oldestAt === ev.newestAt
    ? ` Recorded ${ev.oldestAt}.`
    : ` Recorded ${ev.oldestAt} through ${ev.newestAt}.`;
}

function coverageNote(coverage: DiskSweepCoverage): string {
  const parts: string[] = [];
  if (coverage.invalidRows > 0) parts.push(`${coverage.invalidRows} line(s) failed the row contract and were not counted`);
  if (coverage.truncated) parts.push('the bounded tail cut older rows, so counts are a lower bound');
  if (coverage.sourceState !== 'read') parts.push(`the journal read state was '${coverage.sourceState}'`);
  return parts.length === 0 ? '' : ` Journal coverage: ${parts.join('; ')}.`;
}

function stepFailurePrompt(ev: DiskSweepEvidence, coverage: DiskSweepCoverage): string {
  const tally = ev.failingSteps.map((s) => `\`${s.name}\` ${s.count}x`).join(', ');
  return [
    `Phantom's fleet disk sweep keeps failing its remediation steps — ${ev.stepFailures.rows} journaled sweep(s) across ${ev.stepFailures.days.size} UTC days inside the window ran a step that exited non-zero, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one \`phm fleet disk-sweep --log\` run where wt-cache or worktree-stale ran and returned a non-zero exit — the sweep tried to relieve disk pressure and the step itself failed, so whatever the step was meant to reclaim stayed on disk.${spanText(ev)} Failing-step tally: ${tally}.${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the steps keep failing: the sweep invokes \`fleet wt-cache\` (src/cli/fleet-wt-cache.ts — rebuildable node_modules/target/.next caches in idle job worktrees under the worktrees root) then \`fleet worktree-stale\` (src/cli/fleet-worktree-stale.ts — stale job worktrees judged through the jobs-ledger dialect) in-process from cmdFleetDiskSweep. Exit 1 covers scan or removal errors inside either step; check whether the failure clusters on one step (the tally names it), on a permission or missing-path condition in the worktrees root, on ledger rows whose shape drifted from what worktree-stale parses, or on a host condition only a person can clear. Reproduce with \`phm fleet disk-sweep --history\` for the recorded rows and \`phm host disk\` for the current pressure; the sibling disk-backlog items carry the underlying freeze-line evidence. Fix what lives in this repository; if the cause is host state, pinned ops machinery or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function zeroYieldPrompt(ev: DiskSweepEvidence, coverage: DiskSweepCoverage): string {
  return [
    `Phantom's fleet disk sweeps keep reclaiming nothing under disk pressure — ${ev.zeroYield.rows} of ${ev.pressuredAppliedSweeps} applied, pressured sweep(s) inside the window recorded freedGb of 0 across ${ev.zeroYield.days.size} UTC days, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one \`phm fleet disk-sweep --apply --log\` run that fired below the ${ev.freezeBelowGb} GB freeze line (the live readFreezeLine value, source '${ev.freezeSource}'), ran both steps for real, and recorded zero GB freed — wt-cache found no rebuildable caches and worktree-stale found no stale worktrees, or both steps no-oped while the disk stayed under the line.${spanText(ev)} Of ${ev.rows} journaled rows, ${ev.appliedRows} were applied, ${ev.dryRunRows} dry runs, ${ev.unsweptRows} never swept, and ${ev.unmeasuredSweeps} swept without a readable freeGb.${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the sweep finds nothing to reclaim while the disk stays pressured: wt-cache only counts node_modules/target/.next dirs directly inside job worktrees idle past --min-hours and skips running jobs and guardian-* dirs; worktree-stale judges staleness through the jobs ledger. Check whether the real consumer sits outside both steps' reach — job folders, model weights, logs, caches elsewhere — by cross-referencing \`phm host disk\`'s worktrees section, \`phm worktrees plan\`'s reapable set and the sibling disk-backlog items' below-freeze and runway evidence, whether the steps' eligibility rules exclude the dirs that actually hold the GB (min-hours, running-job skips, the worktrees root), or whether the pressure is transient and resolves before a sweep matters. Fix what lives in this repository — step coverage, eligibility rules, or a missing reclaim path; if the consumer is owner-side apps, pinned ops machinery or outside the fleet's reach — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function diskSweepItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'disk-pressure',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the disk-sweep journal's recurring adverse
 * evidence: swept rows whose steps keep exiting non-zero and applied
 * pressured sweeps that keep recording zero freed GB, each at the
 * recurring bars of rows across distinct UTC days inside the window.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function diskSweepBacklogItems(opts: DiskSweepItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const [sweepRead, freeze] = await Promise.all([
      readLedgerTail(join(runsDir, 'queue', 'disk-sweep.jsonl'), DISK_SWEEP_TAIL_BYTES),
      readFreezeLine(runsDir),
    ]);
    // A missing, non-file or unreadable journal is the writer's normal
    // state — --log is opt-in — and contributes nothing.
    if (sweepRead.state !== 'read') return [];
    const parsed = parseDiskSweepJournal(sweepRead.text);
    if (parsed.rows.length === 0) return [];
    const ev = foldDiskSweepEvidence(parsed.rows, {
      nowMs,
      freezeBelowGb: freeze.gb,
      freezeSource: freeze.source,
      windowMs: opts.windowMs,
    });
    const coverage: DiskSweepCoverage = {
      invalidRows: parsed.invalidRows,
      truncated: sweepRead.truncated,
      sourceState: sweepRead.state,
    };
    const items: CloudBacklogItem[] = [];
    if (ev.stepFailures.rows >= DISK_SWEEP_MIN_ROWS && ev.stepFailures.days.size >= DISK_SWEEP_MIN_DAYS) {
      items.push(diskSweepItem(
        'disk-sweep-step-failures',
        'Fleet disk sweep steps keep failing',
        stepFailurePrompt(ev, coverage),
        repo,
      ));
    }
    if (ev.zeroYield.rows >= DISK_SWEEP_MIN_ROWS && ev.zeroYield.days.size >= DISK_SWEEP_MIN_DAYS) {
      items.push(diskSweepItem(
        'disk-sweep-zero-yield',
        'Fleet disk sweeps keep reclaiming nothing under pressure',
        zeroYieldPrompt(ev, coverage),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DISK_SWEEP_MAX_ITEMS, DISK_SWEEP_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
