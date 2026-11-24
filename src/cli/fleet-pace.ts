/** Pool pace with a five percent reserve; optional owned loop stops. */
import { readFile } from 'node:fs/promises';
import { paceStops } from '../core/fleet/pace-stops.js';
import { isAbsolute } from 'node:path';
import { paceLine, readFleetPace, type FleetPaceV1 } from '../core/fleet/pace-verdict.js';

const USAGE = 'Usage: phm fleet pace [--json] [--runs-dir <abs>] [--write-stops <dir> --loops <file> [--apply]]';

export interface FleetPaceDeps { read?: (runsDir?: string) => Promise<FleetPaceV1> }

export async function cmdFleetPace(args: string[], deps: FleetPaceDeps = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) {
    console.log(`${USAGE}\nOne line per pool: used percent, hours left, actual and safe hourly burn, time to empty. --json prints fleet.pace.v1; state retains the routing verdict. Five percent stays in reserve: verdict ok, over or unknown. --write-stops plans STOP files using a JSON map such as {"claude":["docs"]} from --loops; --apply writes or clears only owned files. Exit 0 report, 2 usage.`);
    return 0;
  }
  let runsDir: string | undefined;
  let json = false, apply = false;
  let stops: string | undefined, loops: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--apply') apply = true;
    else if ((arg === '--write-stops' || arg === '--loops') && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      const value = args[++i]!; if (arg === '--write-stops') stops = value; else loops = value;
    } else if (arg === '--runs-dir' && args[i + 1] !== undefined && isAbsolute(args[i + 1]!)) runsDir = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  if (Boolean(stops) !== Boolean(loops) || apply && !stops) { console.error(USAGE); return 2; }
  const report = await (deps.read ?? (dir => readFleetPace(dir === undefined ? {} : { runsDir: dir })))(runsDir);
  let stopPlan;
  try { if (stops && loops) stopPlan = await paceStops(report, stops, JSON.parse(await readFile(loops, 'utf8')), apply); }
  catch { console.error('Could not plan or apply pace stops; check the loop config and directory.'); return 2; }
  if (json) console.log(JSON.stringify({ ...report, ...(stopPlan ? { stops: stopPlan } : {}) }));
  else if (report.pools.length === 0) console.log('Pace: unknown (no pool readings)');
  else for (const v of report.pools) console.log(paceLine(v));
  if (!json && stopPlan) for (const p of stopPlan.plans) console.log(`${apply ? 'Applied' : 'Would'} ${p.action} STOP-${p.loop}`);
  return 0;
}
