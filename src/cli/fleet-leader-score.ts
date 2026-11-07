/** Read-only results for manually queued Q8 jobs over six hours. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet leader-score [--json]';
export interface LeaderScoreJob {
  job: string; launched: boolean; precheck_code: string | number | null;
  pr_url: string | null; merged: boolean; ttm_s: number | null;
}
export interface LeaderScoreReport {
  schema: 'fleet.leader-score.v1'; window_hours: 6; known: boolean;
  jobs: LeaderScoreJob[];
  totals: { jobs: number; launched: number; precheck: number; prs: number; merged: number } | null;
  median_ttm_s: number | null;
}

/** Latest timestamp wins for precheck, PR and outcome fields; duplicate events count once. */
export async function fleetLeaderScore(read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<LeaderScoreReport> {
  const report: LeaderScoreReport = { schema: 'fleet.leader-score.v1', window_hours: 6,
    known: false, jobs: [], totals: null, median_ttm_s: null };
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return report;
  const rows: { row: Record<string, unknown>; at: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (Number.isFinite(at) && at >= now - 6 * 3_600_000 && at <= now) rows.push({ row: r, at });
    } catch { /* Ignore malformed or partial lines, as other ledger reports do. */ }
  }
  const jobs = new Map<string, LeaderScoreJob>();
  for (const { row } of rows.sort((a, b) => a.at - b.at)) {
    const id = row.job ?? row.job_id ?? row.id;
    if (typeof id !== 'string' || !id.endsWith('Q8') || /A\d{6}.*Q8$/.test(id)) continue;
    if (!['launch', 'precheck_skip', 'publish', 'outcome'].includes(String(row.event))) continue;
    const job = jobs.get(id) ?? { job: id, launched: false, precheck_code: null, pr_url: null, merged: false, ttm_s: null };
    jobs.set(id, job);
    if (row.event === 'launch') job.launched = true;
    if (row.event === 'precheck_skip' && (typeof row.code === 'string' || typeof row.code === 'number')) job.precheck_code = row.code;
    if ((row.event === 'publish' || row.event === 'outcome') && typeof row.url === 'string'
      && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(row.url)) job.pr_url = row.url;
    if (row.event === 'outcome') {
      job.merged = row.state === 'MERGED';
      job.ttm_s = job.merged && typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0 ? row.ttm_s : null;
    }
  }
  report.known = true;
  report.jobs = [...jobs.values()].sort((a, b) => a.job.localeCompare(b.job));
  report.totals = { jobs: jobs.size, launched: 0, precheck: 0, prs: 0, merged: 0 };
  for (const job of report.jobs) {
    report.totals.launched += Number(job.launched);
    report.totals.precheck += Number(job.precheck_code !== null);
    report.totals.prs += Number(job.pr_url !== null);
    report.totals.merged += Number(job.merged);
  }
  const times = report.jobs.flatMap(job => job.ttm_s === null ? [] : [job.ttm_s]).sort((a, b) => a - b);
  if (times.length) report.median_ttm_s = (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2;
  return report;
}

export async function cmdFleetLeaderScore(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead the last 6 hours of jobs.jsonl for Q8 jobs without A plus six digits before Q8. Show launches, latest precheck code, PR, merge and time to merge in seconds. Totals count jobs once; median uses valid merged times. Unread metrics are unknown.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  const report = await fleetLeaderScore(read, now);
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(report.totals === null
    ? 'Leader score: unknown (metrics unreadable)'
    : [...report.jobs.map(j => `${j.job}: launched ${j.launched ? 'yes' : 'no'}, precheck ${j.precheck_code ?? 'unknown'}, PR ${j.pr_url ?? 'unknown'}, merged ${j.merged ? 'yes' : 'no'}, time to merge ${j.ttm_s ?? 'unknown'} seconds`),
      `Last 6 hours: ${report.totals.jobs} jobs, ${report.totals.launched} launched, ${report.totals.precheck} prechecks, ${report.totals.prs} PRs, ${report.totals.merged} merged; median time to merge ${report.median_ttm_s ?? 'unknown'} seconds.`].join('\n')));
  return 0;
}
