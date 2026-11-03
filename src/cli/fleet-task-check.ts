/** Read-only: warns when a job's batch keeps finishing empty. Never changes dispatch or merge authority. */
import { readJobsMetrics, type JobsMetricsReader } from '../core/fleet/jobs-metrics.js';

const usage = 'Usage: ashlr fleet task-check <job-id> [--json]';
const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = 3;

export type TaskCheckReader = JobsMetricsReader;

export interface TaskCheckReport {
  schema: 'fleet.task-check.v1';
  job: string;
  batch: string;
  /** false when the metrics file could not be read; likely_empty is then false and means nothing. */
  known: boolean;
  likely_empty: boolean;
  skipped_empty: number;
  precheck_skip: number;
  window_hours: 24;
}
export const readTaskCheckJobs = readJobsMetrics;

/** The job id with its trailing number removed: RQ-PHX-FOO03 -> RQ-PHX-FOO. */
export const taskBatch = (job: string): string => job.replace(/\d+$/, '') || job;

export async function taskCheck(job: string, read: TaskCheckReader, now = Date.now()): Promise<TaskCheckReport> {
  const batch = taskBatch(job);
  const base = { schema: 'fleet.task-check.v1', job, batch, window_hours: 24 } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return { ...base, known: false, likely_empty: false, skipped_empty: 0, precheck_skip: 0 };
  let skipped = 0;
  let precheck = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const id = row.job ?? row.job_id ?? row.id;
    if (typeof id !== 'string' || taskBatch(id) !== batch) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at > now || now - at > DAY_MS) continue;
    const kinds = [row.event, row.outcome, row.state];
    if (kinds.includes('skipped_empty')) skipped++;
    else if (kinds.includes('precheck_skip')) precheck++;
  }
  return { ...base, known: true, likely_empty: skipped + precheck >= THRESHOLD, skipped_empty: skipped, precheck_skip: precheck };
}

export async function cmdFleetTaskCheck(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nSays whether the job's batch (job id minus its trailing number) had ${THRESHOLD} or more skipped_empty or precheck_skip rows in the last 24 hours, so it likely has nothing to do. Reads ~/.ashlr-runs/metrics/jobs.jsonl; an unreadable file reports known:false.`);
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  if (rest.length !== 1 || args.length - rest.length > 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rest[0]!)) {
    console.error(`error: invalid fleet task-check arguments\n${usage}`);
    return 2;
  }
  const report = await taskCheck(rest[0]!, read, now);
  console.log(json ? JSON.stringify(report) : !report.known
    ? `${report.job}: unknown (metrics unreadable)`
    : `${report.job}: ${report.likely_empty ? 'likely empty' : 'ok'} (batch ${report.batch}: ${report.skipped_empty} skipped_empty, ${report.precheck_skip} precheck_skip in 24h)`);
  return 0;
}
