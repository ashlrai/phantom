/** `phm jobs lost`: thin handler. The logic lives in core/fleet/lost-launches.ts. */
import { parseArgs } from 'node:util';
import { lostLaunchesLines, readLostLaunches, requeueHint, type LostLaunchesReport } from '../core/fleet/lost-launches.js';

const usage = 'Usage: phm jobs lost [--since 24h] [--requeue-hint] [--json]';
const help = `${usage}
Jobs that launched and vanished: no finish or publish within 30 minutes of the launch event in metrics/jobs.jsonl, or a <ID>.launch file that starts with "error:" (for example a git ref lock race between two launches).
--requeue-hint prints the queue/ready.tsv line (id, repo, lane) to re-add for each; it never writes ready.tsv. --json prints jobs.lost.v1.
Exit 0 report, 1 job metrics unreadable, 2 bad usage. Reads only.`;

export async function cmdJobsLost(args: string[], read: (hours: number) => Promise<LostLaunchesReport> = hours => readLostLaunches(hours)): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, 'requeue-hint': { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  let hours = 24;
  if (values.since !== undefined) {
    const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(values.since);
    hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
    if (!(hours > 0 && hours <= 8760)) { console.error(`${usage}\n--since takes a number and h or d, like 24h.`); return 2; }
  }
  const report = await read(hours);
  const hint = values['requeue-hint'] === true;
  if (values.json) console.log(JSON.stringify(hint ? { ...report, requeue_hints: report.lost.map(requeueHint) } : report));
  else for (const line of lostLaunchesLines(report, hint)) (report.known ? console.log : console.error)(line);
  return report.known ? 0 : 1;
}
