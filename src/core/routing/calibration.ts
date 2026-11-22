import { readFileSync } from 'node:fs';
import { isRewardSignalV1 } from '../metrics/reward-signal.js';
import { ledgerAtMs, ledgerJobId, ledgerLane, ledgerPhase } from '../fleet/empty-cause.js';
import { ledgerLifecycleEvent, ledgerOutcomeState } from '../fleet/jobs-ledger-dialect.js';
import { hasRevertEvidence } from '../fleet/slot-yield.js';
import { parseLedgerTs } from '../metrics/loop.js';

type Row = Record<string, unknown>;
type Metric = { predicted: number | null; actual: number | null; paired: number };
export interface CalibrationArm {
  arm: string;
  jobs: number;
  resolved: number;
  mergeRate: Metric;
  brier: number | null;
  tokens: Metric;
  wallTimeMs: Metric;
}
export interface CalibrationReport {
  schemaVersion: 1;
  arms: CalibrationArm[];
  unmatchedPosthogRuns: number;
}

/**
 * jobs.jsonl is written in several dialects: dispatchd rows use
 * job/event/ts/lane, the metrics-outcomes reconciler copies publish-shaped
 * rows with jobId/outcome/mergedAt, and eval/batcher rows spell the same
 * facts as type|kind, phase|state|outcome|status|result|conclusion and
 * timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt. The fleet
 * dialect helpers in empty-cause/jobs-ledger-dialect resolve one row's id,
 * lifecycle event, stamp and outcome state across all of them.
 */
const SESSION_POOL_SCHEMA = 'fleet.session-pool.v1';
/** RQ-BATCH-* ids name batch session machinery, not job attempts (outcome-metrics convention). */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';
/** Attempt boundaries in jobs.jsonl vocabulary (fleet/outcome-metrics.ts). */
const DISPATCH_KINDS: ReadonlySet<string> = new Set(['launch', 'batch_claim']);
const FINISH_KINDS: ReadonlySet<string> = new Set(['finish', 'task_outcome']);
/** Named events whose phase can carry a merge verdict. */
const VERDICT_KINDS: ReadonlySet<string> = new Set(['outcome', 'merged', 'closed', 'resolved', 'resolution', 'result']);
const MERGED_AT_KEYS = ['mergedAt', 'merged_at', 'closedAt', 'closed_at'] as const;
/** Negative terminal phases: the PR resolved without merging (old outcome() vocabulary, uppercased). */
const CLOSED_STATES: ReadonlySet<string> = new Set(['CLOSED', 'NOT_MERGED', 'NOT-MERGED', 'REJECTED', 'FAILED']);

interface MetricSnap {
  predictedMergeRate?: number;
  predictedTokens?: number;
  predictedWallTimeMs?: number;
  tokens?: number;
  wallTimeMs?: number;
}
interface Mark { seq: number; at: number | null; snap: MetricSnap }
interface DispatchMark extends Mark { arm: string | null }
interface JobMarks {
  dispatches: DispatchMark[];
  finishes: Mark[];
  publishes: number;
  /** Standing merge verdict: the newest resolved-outcome row, or null while unresolved. */
  verdict: { at: number | null; seq: number; merged: boolean; mergedAtMs: number | null } | null;
  /** Newest positive revert-evidence row; a merge it postdates did not hold. */
  revert: { at: number | null; seq: number } | null;
  /** Newest-wins metric fields across every recognized row (fallback evidence). */
  metrics: MetricSnap;
}
interface Job {
  arm?: string;
  prediction?: number;
  predictedTokens?: number;
  predictedWallTimeMs?: number;
  tokens?: number;
  wallTimeMs?: number;
  started?: number;
  finished?: number;
  merged?: boolean;
  launched: boolean;
  /** A reward-signal row was seen: a self-contained outcome record, not a launch. */
  rewarded?: boolean;
  /** Fleet-dialect fold state; absent for reward-only jobs. */
  marks?: JobMarks;
}

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function field(row: Row, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name];
  return undefined;
}
function stringField(row: Row, ...names: string[]): string | undefined {
  const value = field(row, ...names);
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function numberField(row: Row, names: string[], max = Infinity): number | undefined {
  const value = field(row, ...names);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`Invalid ${names[0]}`);
  return value;
}
function assign<K extends keyof Job>(job: Job, key: K, value: Job[K] | undefined): void {
  if (value === undefined) return;
  if (job[key] !== undefined && job[key] !== value) throw new Error(`Conflicting ${key} for a job`);
  job[key] = value;
}
/**
 * Order two ledger marks: timestamps order when both parse (ties fall to
 * ledger order), otherwise file order decides. seq is the row's index, so
 * append order stands in for chronology when a stamp is missing.
 */
function compareMarks(aAt: number | null, aSeq: number, bAt: number | null, bSeq: number): number {
  if (aAt !== null && bAt !== null) return aAt === bAt ? aSeq - bSeq : aAt - bAt;
  return aSeq - bSeq;
}
/** The GitHub merge timestamp a MERGED row carries, when it has one (reward-feed's key set). */
function mergedAtMs(row: Row): number | null {
  for (const key of MERGED_AT_KEYS) {
    const at = parseLedgerTs(row[key]);
    if (at !== null) return at;
  }
  return null;
}
/** Metric fields one row records, across the prediction and usage dialects. */
function metricSnap(row: Row): MetricSnap {
  const snap: MetricSnap = {};
  const merge = numberField(row, ['predictedMergeRate', 'predicted_merge_rate', 'predictedMergeProbability', 'predicted_merge_probability'], 1);
  if (merge !== undefined) snap.predictedMergeRate = merge;
  const pt = numberField(row, ['predictedTokens', 'predicted_tokens']);
  if (pt !== undefined) snap.predictedTokens = pt;
  const pw = numberField(row, ['predictedWallTimeMs', 'predicted_wall_time_ms']);
  if (pw !== undefined) snap.predictedWallTimeMs = pw;
  const tk = numberField(row, ['tokens', 'totalTokens', 'total_tokens', 'tokens_total', 'tokensTotal']);
  if (tk !== undefined) snap.tokens = tk;
  const wm = numberField(row, ['wallTimeMs', 'wall_time_ms', 'duration_ms']);
  if (wm !== undefined) snap.wallTimeMs = wm;
  else {
    const ws = numberField(row, ['wall_s', 'wallS']);
    if (ws !== undefined) snap.wallTimeMs = ws * 1000;
  }
  return snap;
}
function mergeSnap(into: MetricSnap, snap: MetricSnap): void {
  if (snap.predictedMergeRate !== undefined) into.predictedMergeRate = snap.predictedMergeRate;
  if (snap.predictedTokens !== undefined) into.predictedTokens = snap.predictedTokens;
  if (snap.predictedWallTimeMs !== undefined) into.predictedWallTimeMs = snap.predictedWallTimeMs;
  if (snap.tokens !== undefined) into.tokens = snap.tokens;
  if (snap.wallTimeMs !== undefined) into.wallTimeMs = snap.wallTimeMs;
}
function parseJsonl(input: string): Row[] {
  return input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSON at jobs line ${index + 1}`); }
    const row = object(value);
    if (!row) throw new Error(`Invalid event at jobs line ${index + 1}`);
    return [row];
  });
}
function parseExport(input: string): Row[] {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error('Invalid PostHog JSON export'); }
  const container = object(value);
  const rows = Array.isArray(value) ? value : container?.['results'];
  if (!Array.isArray(rows)) throw new Error('PostHog export must be an array or an object with results');
  return rows.map((entry: unknown) => {
    const row = object(entry);
    if (!row) throw new Error('Invalid PostHog run');
    return object(row['properties']) ?? row;
  });
}
function pair(jobs: Job[], prediction: (job: Job) => number | undefined, actual: (job: Job) => number | undefined): Metric {
  const pairs = jobs.flatMap((job) => {
    const p = prediction(job); const a = actual(job);
    return p === undefined || a === undefined ? [] : [{ p, a }];
  });
  return {
    predicted: pairs.length ? pairs.reduce((sum, item) => sum + item.p / pairs.length, 0) : null,
    actual: pairs.length ? pairs.reduce((sum, item) => sum + item.a / pairs.length, 0) : null,
    paired: pairs.length,
  };
}
/** Join launches to outcomes. Unknown outcomes remain unresolved. */
export function calibrateRouting(jobsJsonl: string, posthogJson?: string): CalibrationReport {
  const jobs = new Map<string, Job>();
  const rows = parseJsonl(jobsJsonl);
  let recognized = 0;
  for (const [seq, row] of rows.entries()) {
    // Reward-signal rows (metrics/reward-signals.jsonl) are complete per-job
    // outcome records. They join with launch predictions by jobId and supply
    // the verified outcome side the router calibrates against.
    if (isRewardSignalV1(row)) {
      recognized++;
      const job = jobs.get(row.jobId) ?? { launched: false };
      jobs.set(row.jobId, job);
      job.rewarded = true;
      if (row.pool !== null) assign(job, 'arm', row.pool);
      assign(job, 'started', Date.parse(row.dispatchedAt));
      if (row.mergedAt !== null) assign(job, 'finished', Date.parse(row.mergedAt));
      if (row.ciWallMs !== null) assign(job, 'wallTimeMs', row.ciWallMs);
      assign(job, 'merged', row.merged);
      continue;
    }
    // Session-pool rows are per-attempt machinery, not lifecycle evidence.
    if (row['schema'] === SESSION_POOL_SCHEMA) continue;
    const phase = ledgerPhase(row);
    const event = ledgerLifecycleEvent(row, phase);
    const dispatch = event !== null && DISPATCH_KINDS.has(event);
    const finish = event !== null && FINISH_KINDS.has(event);
    const publish = event === 'publish';
    const state = ledgerOutcomeState(row, event, phase);
    const mergedFlag = typeof row['merged'] === 'boolean' ? row['merged'] : null;
    const revert = hasRevertEvidence(row);
    if (!(dispatch || finish || publish || (event !== null && VERDICT_KINDS.has(event)) || state !== null || mergedFlag !== null || revert)) continue;
    recognized++;
    const id = ledgerJobId(row);
    if (!id) throw new Error('Event is missing job ID');
    // Batch session ids aggregate member attempts; member rows carry the job id.
    if (id.startsWith(BATCH_SESSION_PREFIX)) continue;
    const job = jobs.get(id) ?? { launched: false };
    jobs.set(id, job);
    const marks = job.marks ??= { dispatches: [], finishes: [], publishes: 0, verdict: null, revert: null, metrics: {} };
    const at = ledgerAtMs(row);
    const snap = metricSnap(row);
    mergeSnap(marks.metrics, snap);
    if (dispatch) marks.dispatches.push({ seq, at, arm: ledgerLane(row), snap });
    else if (finish) marks.finishes.push({ seq, at, snap });
    else if (publish) marks.publishes++;
    if (revert && (marks.revert === null || compareMarks(at, seq, marks.revert.at, marks.revert.seq) > 0)) {
      marks.revert = { at, seq };
    }
    let verdictMerged: boolean | null = null;
    if (state === 'MERGED') verdictMerged = true;
    else if (state !== null && CLOSED_STATES.has(state)) verdictMerged = false;
    else if (mergedFlag !== null) verdictMerged = mergedFlag;
    if (verdictMerged === null) continue;
    const standing = marks.verdict;
    const sameInstant = standing !== null && ((at === null && standing.at === null) || (at !== null && standing.at !== null && at === standing.at));
    if (standing !== null && sameInstant && standing.merged !== verdictMerged) throw new Error('Conflicting merged for a job');
    if (standing === null || compareMarks(at, seq, standing.at, standing.seq) > 0) {
      marks.verdict = { at, seq, merged: verdictMerged, mergedAtMs: verdictMerged ? mergedAtMs(row) : null };
    }
  }
  if (rows.length && !recognized) throw new Error('No recognized dispatch events');
  // Resolve each job's fold before PostHog evidence joins: the standing
  // verdict decides merged (a merge a later revert postdates did not hold),
  // the newest dispatch provably at/before the resolution supplies arm,
  // started and predictions, and the finish inside that attempt's window
  // supplies finished, tokens and wall time. Retries are separate attempts —
  // only the attempt that produced the recorded outcome counts.
  for (const job of jobs.values()) {
    const marks = job.marks;
    if (marks === undefined) continue;
    let boundAt: number | null = null;
    let boundSeq = Number.MAX_SAFE_INTEGER;
    const verdict = marks.verdict;
    if (verdict !== null) {
      const held = verdict.merged && (marks.revert === null || compareMarks(verdict.at, verdict.seq, marks.revert.at, marks.revert.seq) > 0);
      assign(job, 'merged', held);
      if (held) { boundAt = verdict.mergedAtMs ?? verdict.at; boundSeq = verdict.seq; }
      else if (verdict.merged && marks.revert !== null) { boundAt = marks.revert.at ?? verdict.at; boundSeq = marks.revert.seq; }
      else { boundAt = verdict.at; boundSeq = verdict.seq; }
    }
    const beforeBound = (m: { at: number | null; seq: number }): boolean => compareMarks(m.at, m.seq, boundAt, boundSeq) <= 0;
    const eligible = marks.dispatches.filter(beforeBound);
    let dispatch = eligible.length
      ? eligible.reduce((a, b) => compareMarks(b.at, b.seq, a.at, a.seq) > 0 ? b : a)
      : null;
    if (dispatch === null && marks.dispatches.length) {
      dispatch = marks.dispatches.reduce((a, b) => compareMarks(b.at, b.seq, a.at, a.seq) < 0 ? b : a);
    }
    if (dispatch !== null) {
      job.launched = true;
      if (dispatch.arm !== null) assign(job, 'arm', dispatch.arm);
      assign(job, 'started', dispatch.at ?? undefined);
    }
    const finishPool = marks.finishes.filter(f => beforeBound(f) && (dispatch === null || compareMarks(f.at, f.seq, dispatch.at, dispatch.seq) >= 0));
    const finish = finishPool.length
      ? finishPool.reduce((a, b) => compareMarks(b.at, b.seq, a.at, a.seq) > 0 ? b : a)
      : null;
    if (finish !== null) {
      assign(job, 'finished', finish.at ?? undefined);
    } else if (dispatch !== null && dispatch.at !== null && marks.dispatches.length === 1) {
      const dispatchAt = dispatch.at;
      const prior = marks.finishes.some(f => f.at !== null && f.at < dispatchAt && beforeBound(f));
      if (prior) throw new Error('Finish precedes launch');
    }
    const snap = marks.metrics;
    assign(job, 'prediction', dispatch?.snap.predictedMergeRate ?? snap.predictedMergeRate);
    assign(job, 'predictedTokens', dispatch?.snap.predictedTokens ?? snap.predictedTokens);
    assign(job, 'predictedWallTimeMs', dispatch?.snap.predictedWallTimeMs ?? snap.predictedWallTimeMs);
    assign(job, 'tokens', finish?.snap.tokens ?? snap.tokens);
    assign(job, 'wallTimeMs', finish?.snap.wallTimeMs ?? snap.wallTimeMs);
  }
  let unmatchedPosthogRuns = 0;
  if (posthogJson !== undefined) for (const row of parseExport(posthogJson)) {
    const id = stringField(row, 'jobId', 'job_id');
    const job = id ? jobs.get(id) : undefined;
    if (!job || (!job.launched && !job.rewarded)) { unmatchedPosthogRuns++; continue; }
    const snap = metricSnap(row);
    assign(job, 'prediction', snap.predictedMergeRate);
    assign(job, 'predictedTokens', snap.predictedTokens);
    assign(job, 'predictedWallTimeMs', snap.predictedWallTimeMs);
    assign(job, 'tokens', snap.tokens);
    assign(job, 'wallTimeMs', snap.wallTimeMs);
  }
  const groups = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (!job.launched && !job.rewarded) {
      const marks = job.marks;
      // Finish/publish/verdict rows without a launch are contradictory; rows
      // that only carried an unresolved phase (DONE-NOOP, OPEN, pending) are
      // queue noise, not routing evidence.
      if (marks !== undefined && (marks.finishes.length > 0 || marks.publishes > 0 || marks.verdict !== null)) {
        throw new Error('Event has no matching launch');
      }
      continue;
    }
    if (!job.arm) {
      if (!job.rewarded) throw new Error('Launch is missing arm');
      job.arm = 'unknown';
    }
    if (job.started !== undefined && job.finished !== undefined) {
      if (job.finished < job.started) throw new Error('Finish precedes launch');
      const duration = job.finished - job.started;
      if (job.wallTimeMs === undefined) job.wallTimeMs = duration;
    }
    const group = groups.get(job.arm) ?? [];
    group.push(job); groups.set(job.arm, group);
  }
  const arms = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([arm, group]): CalibrationArm => {
    const resolved = group.filter((job) => job.merged !== undefined).length;
    const mergeRate = pair(group, (job) => job.prediction, (job) => job.merged === undefined ? undefined : Number(job.merged));
    const scored = group.filter((job) => job.prediction !== undefined && job.merged !== undefined);
    return { arm, jobs: group.length, resolved, mergeRate,
      brier: scored.length ? scored.reduce((sum, job) => sum + (job.prediction! - Number(job.merged)) ** 2 / scored.length, 0) : null,
      tokens: pair(group, (job) => job.predictedTokens, (job) => job.tokens),
      wallTimeMs: pair(group, (job) => job.predictedWallTimeMs, (job) => job.wallTimeMs),
    };
  });
  return { schemaVersion: 1, arms, unmatchedPosthogRuns };
}
export function readCalibration(jobsPath: string, posthogPath?: string): CalibrationReport {
  return calibrateRouting(readFileSync(jobsPath, 'utf8'), posthogPath === undefined ? undefined : readFileSync(posthogPath, 'utf8'));
}
export function calibrationMarkdown(report: CalibrationReport): string {
  const format = (n: number | null): string => n === null ? 'n/a' : Number(n.toFixed(4)).toString();
  const metric = (m: Metric): string => `${format(m.predicted)} / ${format(m.actual)} (${m.paired})`;
  const lines = ['# Router calibration', '', 'Values are predicted / actual (paired jobs). Wall time is in milliseconds.', '',
    '| Arm | Jobs | Resolved | Merge rate | Brier | Tokens | Wall time ms |',
    '| --- | ---: | ---: | --- | ---: | --- | --- |'];
  for (const a of report.arms) lines.push(`| ${a.arm.replace(/[|\\\r\n]/g, ' ')} | ${a.jobs} | ${a.resolved} | ${metric(a.mergeRate)} | ${format(a.brier)} | ${metric(a.tokens)} | ${metric(a.wallTimeMs)} |`);
  lines.push('', `Unmatched PostHog runs: ${report.unmatchedPosthogRuns}`, '');
  return lines.join('\n');
}
