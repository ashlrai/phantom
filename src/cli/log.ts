import { jobLogDuration, jobLogSummary, readJobLog, type JobLogFilters, type JobLogReport } from '../core/fleet/job-log.js';
import { worklogHours, WORKLOG_DEFAULT_HOURS } from '../core/fleet/worklog.js';

const usage = `Usage: phm log [--since ${WORKLOG_DEFAULT_HOURS}h] [--lane <lane>] [--repo <repo>] [--json]
What the fleet did, one row per job, newest first: when, lane, model, repo, goal, result and time to merge.
The first line is the summary; one line per lane follows. Read-only. Anything not recorded prints as unknown.
For every single event (launches, leader replies, incidents) use phm worklog.`;
const pad = (n: number) => String(n).padStart(2, '0');

/** Human lines: the summary, one line per lane, then one line per job. */
export function jobLogText(report: JobLogReport, filtered: boolean): string[] {
  const lines = [`Last ${report.hours ?? WORKLOG_DEFAULT_HOURS} hours: ${report.headline}`,
    ...report.summary.lanes.map(lane => `  ${lane.lane}: ${jobLogSummary(lane)}`)];
  if (!report.jobs.length) lines.push(filtered ? 'No jobs match these filters.' : 'No jobs recorded in this period.');
  for (const job of report.jobs) {
    const at = new Date(job.at);
    const result = job.text + (job.result !== 'merged' ? '' : job.mergeSeconds === null ? ', time to merge unknown' : ` in ${jobLogDuration(job.mergeSeconds)}`);
    lines.push([`${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
      [job.lane ?? 'unknown lane', job.model ?? 'unknown model', job.repo ?? 'unknown repo'].join(' · '),
      job.job ?? 'unknown job', job.goal ?? 'goal unknown', result, job.url].filter(Boolean).join('  '));
  }
  if (report.sources.jobs.state === 'unknown') lines.push(`Unknown: job results. ${report.sources.jobs.reason}`);
  if (report.malformedLines > 0) lines.push(`${report.malformedLines} unreadable ledger lines skipped.`);
  return lines;
}

export async function cmdLog(args: string[], read: (hours: number, filters: JobLogFilters) => Promise<JobLogReport> = readJobLog): Promise<number> {
  let hours = WORKLOG_DEFAULT_HOURS, json = false;
  const filters: JobLogFilters = {};
  const fail = () => { console.error(usage); return 2; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') { json = true; continue; }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('-')) return fail();
    if (arg === '--since' || arg === '--hours') { try { hours = worklogHours(value); } catch { return fail(); } }
    else if (arg === '--repo' || arg === '--lane') filters[arg === '--repo' ? 'repo' : 'lane'] = value;
    else return fail();
  }
  try {
    const report = await read(hours, filters);
    console.log(json ? JSON.stringify(report) : jobLogText(report, Boolean(filters.repo || filters.lane)).join('\n'));
    return 0;
  } catch { console.error('Unable to read the job log.'); return 1; }
}
