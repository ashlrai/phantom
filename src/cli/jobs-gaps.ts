/** `phm jobs gaps`: thin handler. The logic lives in core/fleet/job-gaps.ts. */
import { parseArgs } from 'node:util';
import { jobGapsLines, readJobGaps, type JobGapsReport } from '../core/fleet/job-gaps.js';

const usage = 'Usage: phm jobs gaps [--since 24h] [--propose] [--json]';
const help = `${usage}
Turn the gaps that no-change jobs list in their notes into new work. Each gap is one candidate (title, repo, source job, why).
Gaps already in an open idea, the queue or a recent merge are dropped. --propose queues the rest as drop jobs, the same queue as "phm ideas queue".
Prints plain words; --json prints jobs.gaps.v1. Anything unreadable is unknown. Exit 0 report, 1 job metrics unreadable, 2 bad usage.`;

export async function cmdJobsGaps(args: string[], read: (hours: number, propose: boolean) => Promise<JobGapsReport> = (hours, propose) => readJobGaps(hours, { propose })): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, propose: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  let hours = 24;
  if (values.since !== undefined) {
    const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(values.since);
    hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
    if (!(hours > 0 && hours <= 8760)) { console.error(`${usage}\n--since takes a number and h or d, like 24h.`); return 2; }
  }
  const report = await read(hours, values.propose === true);
  if (values.json) console.log(JSON.stringify(report));
  else for (const line of jobGapsLines(report)) (report.known ? console.log : console.error)(line);
  return report.known ? 0 : 1;
}
