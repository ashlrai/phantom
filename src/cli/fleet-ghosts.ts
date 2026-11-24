import { parseArgs } from 'node:util';
import { fleetGhosts, type GhostReport } from '../core/fleet/ghosts.js';

const usage = 'Usage: phm fleet ghosts [--json]';
export async function cmdFleetGhosts(args: string[], read: () => Promise<GhostReport> = () => fleetGhosts()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(`${usage}\nList ghosts by lane. Read only.`); return 0; }
  let values;
  try { ({ values } = parseArgs({ args, options: { json: { type: 'boolean' } }, allowPositionals: false })); }
  catch { console.error(usage); return 2; }
  try {
    const report = await read();
    if (values.json) console.log(JSON.stringify(report));
    else if (!report.known) console.error('Cannot read queue/run; ghosts are unknown.');
    else {
      const ghosts = report.jobs.filter(j => j.state === 'ghost');
      for (const j of ghosts) console.log(`${j.id} ${j.lane} age ${j.ageHours === null ? 'unknown' : Math.floor(j.ageHours) + 'h'} ${j.reason}`);
      if (!ghosts.length) console.log('No ghosts.');
    }
    return report.known ? 0 : 1;
  } catch { console.error('Could not inspect ghosts.'); return 1; }
}
