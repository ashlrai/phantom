/** `phm jobs skipped`: precheck skips with a plain meaning per code. Read-only. */
import { parseArgs } from 'node:util';
import { readSkippedJobs, skippedJobsText, SKIP_DEFAULT_HOURS, type SkippedJobsV1 } from '../core/fleet/skipped-jobs.js';

const usage = 'Usage: phm jobs skipped [--since 24h] [--json]';
export async function cmdJobsSkipped(args: string[], read: (hours: number) => Promise<SkippedJobsV1> = hours => readSkippedJobs({ hours })): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nQueued jobs the dispatcher's precheck dropped before launch, grouped by code with a plain meaning and a count per job family. Read-only: it never re-queues a job. JSON: jobs.skipped.v1.`);
    return 0;
  }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, json: { type: 'boolean' } }, strict: true })); }
  catch { console.error(usage); return 2; }
  let hours = SKIP_DEFAULT_HOURS;
  if (values.since !== undefined) {
    const match = /^(\d+(?:\.\d+)?)h$/.exec(values.since);
    if (!match || Number(match[1]) <= 0 || Number(match[1]) > 8760) { console.error(usage); return 2; }
    hours = Number(match[1]);
  }
  const report = await read(hours);
  if (values.json) console.log(JSON.stringify(report));
  else for (const line of skippedJobsText(report)) (report.known ? console.log : console.error)(line);
  return report.known ? 0 : 1;
}

/** Fleet convention entry point; keep the original jobs command as an alias. */
const FLEET_SKIPPED_USAGE = 'Usage: phm fleet skipped [--since 24h] [--json]';
export async function cmdFleetSkipped(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${FLEET_SKIPPED_USAGE}\nPrecheck skips grouped by code and job family. Read-only. Alias: phm jobs skipped.`);
    return 0;
  }
  return cmdJobsSkipped(args);
}
