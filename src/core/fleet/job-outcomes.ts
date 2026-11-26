/**
 * What each finished fleet job produced (RQ-ZAIEXITN20KQ8): merged, pr_open, pr_closed, empty or failed.
 *
 * The exit code never decides alone. A job whose PR merged is `merged` even when the worker exited 1.
 * Order of evidence: the merge observation (an `outcome` row in the jobs ledger), then the publish
 * record's last RESULT line (`parsePublishResult`, the same parser as `phm jobs state`), then the
 * worker's exit/failure evidence, then its empty mark. Empty says no diff, not success.
 *
 * Reuses `ledgerRows`/`finishesIn` (the ledger readers behind `phm fleet empties`) and
 * `classifyEmptyRun` (the log-tail classifier behind `phm fleet empties` "why") for the reasons.
 * Read-only: bounded, no-follow reads of `<runs>/<job>.publish` and `<runs>/<job>.log`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerEventName, ledgerLane, ledgerPhase, ledgerPrUrl, ledgerRows, readText } from './empty-cause.js';
import { classifyEmptyRun, type EmptyRunReason } from './empties-why.js';
import { finishesIn } from './empties.js';
import { parsePublishResult } from './job-state.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const JOB_OUTCOMES = ['merged', 'pr_open', 'pr_closed', 'empty', 'failed'] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export const JOB_OUTCOMES_SCHEMA = 'fleet.job-outcomes.v1';

type Row = Readonly<Record<string, unknown>>;

export interface JobOutcomeInput {
  /** This job's metric rows, oldest first. */
  events: readonly Row[];
  /** `<runs>/<job>.publish`; null when missing. */
  publish: string | null;
  /** The worker's own newest finish said empty (or the dispatcher skipped the job). */
  empty: boolean;
  /** Exit code of the newest finish; null when not recorded. */
  exitCode: number | null;
}

/**
 * Terminal phase tokens that mark a row as carrying a job/PR outcome even when
 * its event keeps a launch or publish spelling — the metrics-outcomes
 * reconciler writes exactly that. The EMPTY family counts too: it is a
 * terminal outcome, just not a PR merge.
 */
const OUTCOME_PHASES: ReadonlySet<string> = new Set([
  'MERGED', 'CLOSED', 'OPEN',
  'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'DONE-NOOP', 'NOOP',
  'FAILED', 'ERROR',
]);
/** Event names (post-normalization, lowercase) that name an outcome directly. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'merged', 'closed']);

/** True when the row records a job/PR outcome — a named outcome event or a terminal phase on any event spelling. */
function isOutcomeRow(row: Row): boolean {
  const eventName = ledgerEventName(row);
  if (eventName !== null && OUTCOME_EVENTS.has(eventName)) return true;
  const phase = ledgerPhase(row);
  return phase !== null && OUTCOME_PHASES.has(phase);
}

/** The uppercased outcome state an outcome row carries; '' when an outcome event names no state. */
function outcomeState(row: Row): string {
  const phase = ledgerPhase(row);
  if (phase !== null) return phase;
  const eventName = ledgerEventName(row);
  if (eventName === 'merged') return 'MERGED';
  if (eventName === 'closed') return 'CLOSED';
  return '';
}

/** Pure: the outcome of one finished job. Exit code is the last resort, never the first. */
export function classifyJobOutcome(input: JobOutcomeInput): { outcome: JobOutcome; pr: string | null } {
  const states = input.events.filter(isOutcomeRow).map(outcomeState);
  const parsed = input.publish === null ? null : parsePublishResult(input.publish);
  const publishedPr = parsed?.result?.kind === 'pr' ? parsed.result.url : null;
  const rowPr = [...input.events].reverse()
    .map(row => (isOutcomeRow(row) ? ledgerPrUrl(row) : null))
    .find((url): url is string => url !== null) ?? null;
  const pr = publishedPr ?? rowPr;
  if (states.includes('MERGED')) return { outcome: 'merged', pr };
  if (states.at(-1) === 'CLOSED') return { outcome: 'pr_closed', pr };
  if (pr !== null) return { outcome: 'pr_open', pr };
  const lastResult = input.publish?.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('RESULT ')).at(-1);
  if (lastResult && /^RESULT (?:ABORT|DENIED)\b/.test(lastResult)) return { outcome: 'failed', pr: null };
  const finish = [...input.events].reverse().find(row => ledgerEventName(row) === 'finish');
  const failed = input.exitCode !== null && input.exitCode !== 0 || Boolean(finish?.pool_error)
    || ['FAILED', 'ERROR'].includes(states.at(-1) ?? '');
  return { outcome: failed ? 'failed' : 'empty', pr: null };
}

/** Plain words for each reason; they read as the end of "most empty: ...". */
const REASON_WORDS: Record<EmptyRunReason, string> = {
  plan_limit: 'plan limit reached',
  held: 'lane was held',
  precheck_skip: 'precheck skipped the task',
  publish_abort: 'publish step refused the change',
  already_done: 'task already on master',
  blocked: 'a tool or network was blocked',
  no_output: 'worker stopped without output',
  unknown: 'no reason in the log',
};

export interface JobOutcomeRow {
  job: string; lane: string; outcome: JobOutcome;
  /** Exit code of the newest finish; null when not recorded. Shown for context, never decisive. */
  exit_code: number | null;
  pr: string | null;
  /** Plain-words reason; only for empty and failed jobs. */
  reason: string | null;
}
export interface OutcomeReason { reason: string; jobs: number }
export interface LaneOutcomes {
  lane: string; total: number;
  counts: Record<JobOutcome, number>;
  /** Top 3 reasons, most jobs first. */
  top_empty: OutcomeReason[];
  top_failed: OutcomeReason[];
  /** One line for the desktop lane card and the terminal, e.g. "zai: 1 merged of 56; most empty: task already on master". */
  summary: string;
}
export interface JobOutcomesReport {
  schema: typeof JOB_OUTCOMES_SCHEMA;
  hours: number;
  lane: string | null;
  /** False when the jobs ledger is unreadable; lanes and jobs are then empty. */
  known: boolean;
  total: number;
  counts: Record<JobOutcome, number>;
  top_empty: OutcomeReason[];
  top_failed: OutcomeReason[];
  lanes: LaneOutcomes[];
  /** Every finished job in the window, by job id. */
  jobs: JobOutcomeRow[];
}

const zero = (): Record<JobOutcome, number> => ({ merged: 0, pr_open: 0, pr_closed: 0, empty: 0, failed: 0 });
const top = (rows: readonly JobOutcomeRow[], outcome: JobOutcome): OutcomeReason[] => {
  const tally = new Map<string, number>();
  for (const row of rows) if (row.outcome === outcome && row.reason) tally.set(row.reason, (tally.get(row.reason) ?? 0) + 1);
  return [...tally].map(([reason, jobs]) => ({ reason, jobs })).sort((a, b) => b.jobs - a.jobs || a.reason.localeCompare(b.reason)).slice(0, 3);
};
const count = (rows: readonly JobOutcomeRow[]): Record<JobOutcome, number> => {
  const counts = zero();
  for (const row of rows) counts[row.outcome]++;
  return counts;
};

/** Pure: "zai: 1 merged of 56; most empty: task already on master". Plain words, one line. */
export function outcomeSummaryLine(lane: string, counts: Record<JobOutcome, number>, topEmpty: readonly OutcomeReason[], topFailed: readonly OutcomeReason[]): string {
  const total = JOB_OUTCOMES.reduce((sum, key) => sum + counts[key], 0);
  if (total === 0) return `${lane}: no finished jobs`;
  const parts = [`${lane}: ${counts.merged} merged of ${total}`];
  if (counts.empty > 0 && topEmpty[0]) parts.push(`most empty: ${topEmpty[0].reason}`);
  if (counts.failed > 0 && topFailed[0]) parts.push(`most failed: ${topFailed[0].reason}`);
  return parts.join('; ');
}

/** Pure: the rollup over classified jobs. `rows` null means the ledger was unreadable. */
export function rollupJobOutcomes(rows: readonly JobOutcomeRow[] | null, hours: number, lane: string | null): JobOutcomesReport {
  const jobs = [...(rows ?? [])].sort((a, b) => a.job.localeCompare(b.job));
  const lanes = [...new Set(jobs.map(row => row.lane))].sort().map((name): LaneOutcomes => {
    const own = jobs.filter(row => row.lane === name);
    const counts = count(own);
    const top_empty = top(own, 'empty'), top_failed = top(own, 'failed');
    return { lane: name, total: own.length, counts, top_empty, top_failed, summary: outcomeSummaryLine(name, counts, top_empty, top_failed) };
  }).sort((a, b) => b.total - a.total || a.lane.localeCompare(b.lane));
  return { schema: JOB_OUTCOMES_SCHEMA, hours, lane, known: rows !== null, total: jobs.length, counts: count(jobs),
    top_empty: top(jobs, 'empty'), top_failed: top(jobs, 'failed'), lanes, jobs };
}

/** Plain-words view for a terminal. */
export function jobOutcomesText(report: JobOutcomesReport): string[] {
  if (!report.known) return [`Job outcomes (last ${report.hours} h): unknown, the job metrics file could not be read.`];
  if (!report.total) return [`Job outcomes (last ${report.hours} h): no finished jobs${report.lane ? ` for ${report.lane}` : ''}.`];
  const lines = report.lanes.map(lane => lane.summary);
  lines.push(`Last ${report.hours} h: ${JOB_OUTCOMES.map(key => `${report.counts[key]} ${key.replace('_', ' ')}`).join(', ')}.`);
  for (const [label, list] of [['Empty', report.top_empty], ['Failed', report.top_failed]] as const) {
    if (list.length) lines.push(`${label} because: ${list.map(r => `${r.reason} (${r.jobs})`).join(', ')}`);
  }
  return lines;
}

const LEDGER_MAX_BYTES = 32 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const NOTE_MAX_BYTES = 16 * 1024;

export interface ReadJobOutcomesOptions {
  hours: number;
  /** Only this lane; omit for every lane. */
  lane?: string;
  now?: number;
  /** Fleet runs folder; default `ASHLR_RUNS_DIR` or `~/.ashlr-runs`. */
  runsDir?: string;
  /** Metrics file; default `<runsDir>/metrics/jobs.jsonl`. */
  jobsPath?: string;
  /** Injected ledger text (tests); null means unreadable. */
  ledger?: () => Promise<string | null>;
}

/** Read-only: classify every job that finished in the window. Never throws on missing files. */
export async function readJobOutcomes(opts: ReadJobOutcomesOptions): Promise<JobOutcomesReport> {
  const now = opts.now ?? Date.now();
  const lane = opts.lane?.trim() || null;
  const root = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const text = opts.ledger ? await opts.ledger().catch(() => null) : await readText(opts.jobsPath ?? join(root, 'metrics', 'jobs.jsonl'), LEDGER_MAX_BYTES);
  if (text === null) return rollupJobOutcomes(null, opts.hours, lane);
  const { rows } = ledgerRows(text, now, opts.hours);
  const byJob = new Map<string, Record<string, unknown>[]>();
  for (const { id, row } of [...rows].sort((a, b) => a.at - b.at)) {
    const events = byJob.get(id);
    if (events) events.push(row); else byJob.set(id, [row]);
  }
  // A job is finished once the ledger shows a finish, a skip, or a merge observation.
  const finished = finishesIn(rows);
  const outcomeOnly = [...byJob].filter(([id, events]) => !finished.some(f => f.id === id) && events.some(row => isOutcomeRow(row) && ['MERGED', 'CLOSED'].includes(outcomeState(row))));
  const targets = [
    ...finished.map(f => ({ id: f.id, lane: f.lane, exit: f.exitCode, empty: f.empty })),
    ...outcomeOnly.map(([id, events]) => ({ id, lane: events.map(ledgerLane).find((lane): lane is string => lane !== null) ?? 'unknown', exit: null as number | null, empty: false })),
  ].filter(target => lane === null || target.lane === lane);
  const out: JobOutcomeRow[] = [];
  for (let i = 0; i < targets.length; i += 16) {
    out.push(...await Promise.all(targets.slice(i, i + 16).map(async ({ id, lane: jobLane, exit, empty }): Promise<JobOutcomeRow> => {
      // Ids come from ledgerRows, which refuses anything that could leave the runs folder.
      const [publish, log, launchNote] = await Promise.all([
        readText(join(root, `${id}.publish`), NOTE_MAX_BYTES),
        readText(join(root, `${id}.log`), LOG_TAIL_BYTES),
        readText(join(root, `${id}.launch`), NOTE_MAX_BYTES),
      ]);
      const events = byJob.get(id) ?? [];
      const { outcome, pr } = classifyJobOutcome({ events, publish, empty, exitCode: exit });
      const reason = outcome === 'empty' || outcome === 'failed'
        ? REASON_WORDS[classifyEmptyRun({ job: id, events, log, publish, launchNote }).reason] : null;
      return { job: id, lane: jobLane, outcome, exit_code: exit, pr, reason };
    })));
  }
  return sanitizePublicJson(rollupJobOutcomes(out, opts.hours, lane)) as JobOutcomesReport;
}
