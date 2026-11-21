/** `phm jobs gaps`: thin handler. The logic lives in core/fleet/job-gaps.ts. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readPaceByPool } from '../core/fleet/pace-verdict.js';
import { jobGapsLines, readGapQueueInputs, readJobGaps, type GapQueueInputs, type JobGapsReport } from '../core/fleet/job-gaps.js';
import { gapLaneRoom, parkedWords } from '../core/fleet/gap-lane-room.js';
import type { LaneFacts } from '../core/fleet/autofill-lanes.js';
import { readLiveLaneFacts } from '../core/fleet/live-lane-facts.js';

const usage = 'Usage: phm jobs gaps [--since 24h] [--propose] [--max N] [--why] [--json]';
const help = `${usage}
Turn the gaps that finished jobs list into new work. Two sources: no-change jobs (notes or final message) and jobs that opened a PR (a "Remaining gaps", "Not done" or "Follow-ups" list in the notes or the last 80 log lines). Gap headings, and sentences like "not done" or "left it"). Each gap is one candidate (title, repo, source job, why).
Caveats, uncertain statements and gaps without a named file, command, function or test are skipped. Add/missing gaps whose named targets exist on master are likely done. At most 3 new gap jobs per rolling hour. Gaps already in an open idea, the queue or a recent merge are dropped. --propose queues the rest as drop jobs (at most --max N per run, default 3 or ASHLR_GAPS_MAX; a gap that names a gh command goes to codex-personal), the same queue as "phm ideas queue", for repos that have a drop queue; the others are listed as skipped. The fleet self-tick runs this once per tick.
--why writes nothing: it lists kept and skipped gaps with reasons, then prints the numbers the queue-full check uses (ready rows in queue/ready.tsv, rows parked on held or spent lanes, the limit of 40, and whether lane readings were available) so you can see why gaps did or did not queue. Prompt files are never counted.
Prints plain words; --json prints jobs.gaps.v1 (paceNotes lists pace decisions). A pool ahead of pace (empty more than 24 h before its reset, see phm fleet pace) gets no new rows; they go to a pool with room, or are held with the reason. Anything unreadable is unknown. Exit 0 report, 1 job metrics unreadable, 2 bad usage.`;

/** What `--why` prints: the count inputs of the queue-full check, plus the lane rows that are parked. */
export interface GapsWhy extends GapQueueInputs { schema: 'jobs.gaps-why.v1'; parkedNote: string; verdict: string }

export async function readGapsWhy(readLanes: () => Promise<{ lanes: readonly LaneFacts[] }> = () => readLiveLaneFacts(runsDirOf()), now = Date.now()): Promise<GapsWhy> {
  const lanes = (await readLanes().catch(() => null))?.lanes;
  const room = lanes ? gapLaneRoom(lanes, now) : null;
  const inputs = await readGapQueueInputs(runsDirOf(), room);
  const verdict = inputs.full ? 'queue is full: gaps will not queue' : inputs.readyRows === null ? 'ready.tsv unreadable: gaps will queue, the limit was not checked' : `room for ${Math.max(0, inputs.limit - (inputs.launchableRows ?? 0))} more rows`;
  return { schema: 'jobs.gaps-why.v1', ...inputs, parkedNote: room ? parkedWords(room.waiting) : 'lane readings unavailable', verdict };
}
const runsDirOf = (): string => process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');

export async function cmdJobsGaps(args: string[], read: (hours: number, propose: boolean, maxNew?: number) => Promise<JobGapsReport> = async (hours, propose, maxNew) => {
  // Pace steers where proposed rows go; an unreadable pace is an empty map and changes nothing.
  const pace = propose ? await readPaceByPool() : undefined;
  // The same lane reading the self-tick uses; unreadable lanes fall back to counting ready.tsv rows only.
  const lanes = propose ? (await readLiveLaneFacts(runsDirOf()).catch(() => null))?.lanes : undefined;
  return readJobGaps(hours, { propose, ...(maxNew === undefined ? {} : { maxNew }), ...(pace?.size ? { pace } : {}), ...(lanes ? { lanes } : {}) });
}, why: () => Promise<GapsWhy> = readGapsWhy): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { since: { type: 'string' }, propose: { type: 'boolean' }, max: { type: 'string' }, why: { type: 'boolean' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  if (values.why) {
    const gaps = await read(24, false);
    const w = { ...await why(), gaps };
    if (values.json) console.log(JSON.stringify(w));
    else console.log([...jobGapsLines(gaps), `Ready rows in queue/ready.tsv: ${w.readyRows ?? 'unknown'}; parked (cannot launch now): ${w.parkedRows}${w.parkedNote && w.parkedNote !== 'lane readings unavailable' ? ` (${w.parkedNote})` : ''}; launchable: ${w.launchableRows ?? 'unknown'}; limit ${w.limit}.`, `Lane readings: ${w.lanesSource}.`, `So: ${w.verdict}.`].join('\n'));
    return 0;
  }
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
