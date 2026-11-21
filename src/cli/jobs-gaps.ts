/** `phm jobs gaps`: thin handler. The logic lives in core/fleet/job-gaps.ts. */
import { parseArgs } from 'node:util';
import { readPaceByPool } from '../core/fleet/pace-verdict.js';
import { jobGapsLines, readJobGaps, type JobGapsReport } from '../core/fleet/job-gaps.js';

const usage = 'Usage: phm jobs gaps [--since 24h] [--propose] [--max N] [--json]';
const help = `${usage}
Turn the gaps that finished jobs list into new work. Two sources: no-change jobs (notes or final message) and jobs that opened a PR (a "Remaining gaps", "Not done" or "Follow-ups" list in the notes or the last 80 log lines). Gap headings, and sentences like "not done" or "left it"). Each gap is one candidate (title, repo, source job, why).
Gaps already in an open idea, the queue or a recent merge are dropped. --propose queues the rest as drop jobs (at most --max N per run, default 3 or ASHLR_GAPS_MAX; a gap that names a gh command goes to codex-personal), the same queue as "phm ideas queue", for repos that have a drop queue; the others are listed as skipped. The fleet self-tick runs this once per tick.
Prints plain words; --json prints jobs.gaps.v1 (paceNotes lists pace decisions). A pool ahead of pace (empty more than 24 h before its reset, see phm fleet pace) gets no new rows; they go to a pool with room, or are held with the reason. Anything unreadable is unknown. Exit 0 report, 1 job metrics unreadable, 2 bad usage.`;

export async function cmdJobsGaps(args: string[], read: (hours: number, propose: boolean, maxNew?: number) => Promise<JobGapsReport> = async (hours, propose, maxNew) => {
  // Pace steers where proposed rows go; an unreadable pace is an empty map and changes nothing.
  const pace = propose ? await readPaceByPool() : undefined;
  return readJobGaps(hours, { propose, ...(maxNew === undefined ? {} : { maxNew }), ...(pace?.size ? { pace } : {}) });
}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, propose: { type: 'boolean' }, max: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  let hours = 24;
  if (values.since !== undefined) {
    const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(values.since);
    hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
    if (!(hours > 0 && hours <= 8760)) { console.error(`${usage}\n--since takes a number and h or d, like 24h.`); return 2; }
  }
  let maxNew: number | undefined;
  if (values.max !== undefined) {
    maxNew = /^\d{1,2}$/.test(values.max) ? Number(values.max) : NaN;
    if (!(maxNew >= 0 && maxNew <= 40)) { console.error(`${usage}\n--max takes a whole number from 0 to 40.`); return 2; }
  }
  const report = await read(hours, values.propose === true, maxNew);
  if (values.json) console.log(JSON.stringify(report));
  else for (const line of jobGapsLines(report)) (report.known ? console.log : console.error)(line);
  return report.known ? 0 : 1;
}
