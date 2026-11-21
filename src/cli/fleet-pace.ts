/**
 * `phm fleet pace` — one line per usage pool: ahead of pace (empty more than 24 h before its
 * reset), behind (would end with room left), on pace, or unknown. Self-supply uses the same
 * verdicts. Read-only; it never changes a target or a plan.
 */
import { isAbsolute } from 'node:path';
import { paceLine, readFleetPace, type FleetPaceV1 } from '../core/fleet/pace-verdict.js';

const USAGE = 'Usage: phm fleet pace [--json] [--runs-dir <abs>]';

export interface FleetPaceDeps { read?: (runsDir?: string) => Promise<FleetPaceV1> }

export async function cmdFleetPace(args: string[], deps: FleetPaceDeps = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) {
    console.log(`${USAGE}\nOne line per pool: ahead of pace (it would be empty more than 24 h before its reset, so self-supply adds no rows for it), behind (it would end with room left, so it is preferred), on pace, or unknown. --json prints fleet.pace.v1. Read-only. Exit 0 report, 2 usage.`);
    return 0;
  }
  let runsDir: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && args[i + 1] !== undefined && isAbsolute(args[i + 1]!)) runsDir = args[++i]!;
    else { console.error(USAGE); return 2; }
  }
  const report = await (deps.read ?? (dir => readFleetPace(dir === undefined ? {} : { runsDir: dir })))(runsDir);
  if (json) console.log(JSON.stringify(report));
  else if (report.pools.length === 0) console.log('Pace: unknown (no pool readings)');
  else for (const v of report.pools) console.log(paceLine(v));
  return 0;
}
