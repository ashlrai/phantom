import { readFileSync } from 'node:fs';

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
function timestamp(row: Row): number | undefined {
  const value = field(row, 'timestamp', 'at', 'time');
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid event timestamp');
  return Date.parse(value);
}
function assign<K extends keyof Job>(job: Job, key: K, value: Job[K] | undefined): void {
  if (value === undefined) return;
  if (job[key] !== undefined && job[key] !== value) throw new Error(`Conflicting ${key} for a job`);
  job[key] = value;
}
function outcome(row: Row): boolean | undefined {
  const value = field(row, 'merged', 'outcome', 'result', 'status');
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'merged') return true;
  if (['not_merged', 'not-merged', 'closed', 'rejected', 'failed'].includes(value)) return false;
  return undefined;
}
function metrics(job: Job, row: Row): void {
  assign(job, 'prediction', numberField(row, ['predictedMergeRate', 'predicted_merge_rate', 'predictedMergeProbability', 'predicted_merge_probability'], 1));
  assign(job, 'predictedTokens', numberField(row, ['predictedTokens', 'predicted_tokens']));
  assign(job, 'predictedWallTimeMs', numberField(row, ['predictedWallTimeMs', 'predicted_wall_time_ms']));
  assign(job, 'tokens', numberField(row, ['tokens', 'totalTokens', 'total_tokens']));
  assign(job, 'wallTimeMs', numberField(row, ['wallTimeMs', 'wall_time_ms', 'duration_ms']));
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
/** Join one launch per job ID. Unknown outcomes remain unresolved. */
export function calibrateRouting(jobsJsonl: string, posthogJson?: string): CalibrationReport {
  const jobs = new Map<string, Job>();
  const rows = parseJsonl(jobsJsonl);
  let recognized = 0;
  for (const row of rows) {
    const event = stringField(row, 'event', 'type');
    if (!event || !['launch', 'finish', 'publish', 'outcome'].includes(event)) continue;
    recognized++;
    const id = stringField(row, 'jobId', 'job_id', 'id');
    if (!id) throw new Error('Event is missing job ID');
    const job = jobs.get(id) ?? { launched: false };
    jobs.set(id, job);
    if (event === 'launch') {
      if (job.launched) throw new Error('Duplicate launch for a job');
      job.launched = true;
      assign(job, 'arm', stringField(row, 'arm'));
      assign(job, 'started', timestamp(row));
    }
    if (event === 'finish') assign(job, 'finished', timestamp(row));
    if (event === 'outcome') assign(job, 'merged', outcome(row));
    metrics(job, row);
  }
  if (rows.length && !recognized) throw new Error('No recognized dispatch events');
  let unmatchedPosthogRuns = 0;
  if (posthogJson !== undefined) for (const row of parseExport(posthogJson)) {
    const id = stringField(row, 'jobId', 'job_id');
    const job = id ? jobs.get(id) : undefined;
    if (!job || !job.launched) { unmatchedPosthogRuns++; continue; }
    metrics(job, row);
  }
  const groups = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (!job.launched) throw new Error('Event has no matching launch');
    if (!job.arm) throw new Error('Launch is missing arm');
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
