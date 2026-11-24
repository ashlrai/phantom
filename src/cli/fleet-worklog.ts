/** `phm fleet worklog`: the numbers to steer by, per hour and per day, with today against yesterday: PRs merged, time from PR opened to merged, merged PRs per launch and launches that ended with no change, by lane and repo. Read-only; the report is built in core/fleet/worklog-numbers.ts. */
import { fleetWorklogText, readFleetWorklog, WORKLOG_MAX_HOURS, worklogOptions } from '../core/fleet/worklog-numbers.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet worklog [--hours 24] [--by hour|day] [--json]
The numbers to steer by, today against yesterday and per hour or per day: PRs merged, median time from
PR opened to merged, merged PRs per 100 launches, launches that ended with no change, and merged PRs
by lane and by repo. Reads the job metrics file (<fleet runs dir>/metrics/jobs.jsonl). Read-only.
  --hours <n>   hours to list and total, 1 to ${WORKLOG_MAX_HOURS}, default 24
  --by <size>   list by hour (default) or by day
  --json        print fleet.worklog.v1: hourly and daily buckets, window totals and the today lines
A PR counts once however often its job launched. Hours and days start on this machine's clock.
Anything not measured prints as null (JSON) or "unknown" (text), never as zero.
Exit 1 when the job metrics file is unreadable. phm worklog lists the single events behind these counts.`;

export async function cmdFleetWorklog(args: string[], read: typeof readFleetWorklog = readFleetWorklog, out: (line: string) => void = console.log): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false;
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if ((arg === '--hours' || arg === '--by') && args[i + 1] && !args[i + 1]!.startsWith('-')) values[arg] = args[++i]!;
    else { console.error(`phm fleet worklog: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const options = worklogOptions(values['--hours'], values['--by']);
  if (!options) { console.error(`phm fleet worklog: --hours takes 1 to ${WORKLOG_MAX_HOURS} and --by takes hour or day\n${usage}`); return 2; }
  const report = sanitizePublicJson(await read(options)) as Awaited<ReturnType<typeof readFleetWorklog>>;
  out(json ? JSON.stringify(report) : fleetWorklogText(report).join('\n'));
  return report.known ? 0 : 1;
}
