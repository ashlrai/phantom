import { parseArgs } from 'node:util';
import { readLiveJobs, writeLiveJobs } from '../core/fleet/live-jobs.js';
const usage = 'Usage: phm jobs live [--json] [--write <file>]';
export async function cmdJobsLive(args: string[], read = readLiveJobs): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${usage}\nRun markers: moving (log under 10 min), quiet (10–60 min), stuck (over 60 min or confirmed missing process). Stale means older than 48 hours with a confirmed missing process; ignored by the brief. Unknown process evidence stays unknown. Elapsed is seconds. --write atomically saves a compact snapshot without log text.`); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { json: { type: 'boolean' }, write: { type: 'string' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  if (values.write === '') { console.error(usage); return 2; }
  const report = await read();
  try { if (values.write) await writeLiveJobs(values.write, report); }
  catch { console.error('Could not write live jobs.'); return 1; }
  if (values.json) console.log(JSON.stringify(report));
  else if (!report.known) console.log('Running jobs: unknown');
  else if (!report.jobs.length) console.log('No running jobs.');
  else for (const j of report.jobs) console.log(`${j.id} ${j.lane} ${j.repo} ${j.status} started ${j.started} elapsed ${j.elapsed === 'unknown' ? 'unknown' : `${Math.floor(j.elapsed / 60)}m`} last-log ${j.lastLogWrite} · ${j.lastLine}`);
  return report.known ? 0 : 1;
}
