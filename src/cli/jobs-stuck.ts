/** `phm jobs stuck`: thin handler. The logic lives in core/fleet/running-stuck.ts. */
import { parseArgs } from 'node:util';
import { readStuckJobs, stuckLine, type StuckJobsReport } from '../core/fleet/running-stuck.js';

const usage = 'Usage: phm jobs stuck [--lane L] [--json]';
const help = `${usage}
Running jobs that are not really running. STUCK: started over 90 minutes ago and the log has not grown for 30 minutes. GHOST: the recorded process is gone but the run marker is still open, so the lane count is too high.
One line per job: id, lane, age, last log time, why. --json prints jobs.stuck.v1. Reads only; "phm fleet stray-stop --apply" closes ghosts and stops stuck jobs.
Exit 0 nothing stuck, 1 something stuck or the run markers are unreadable, 2 bad usage.`;

export async function cmdJobsStuck(args: string[], read: (lane?: string) => Promise<StuckJobsReport> = lane => readStuckJobs({ lane })): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { lane: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  if (values.lane !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(values.lane)) { console.error(usage); return 2; }
  const report = await read(values.lane);
  if (values.json) console.log(JSON.stringify(report));
  else if (!report.known) console.error('Cannot read the run markers (queue/run), so stuck jobs are unknown.');
  else if (report.stuck.length === 0) console.log(`No stuck jobs (${report.running} running).`);
  else for (const s of report.stuck) console.log(stuckLine(s));
  return !report.known || report.stuck.length > 0 ? 1 : 0;
}
