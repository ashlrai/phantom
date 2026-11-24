/** `phm fleet lane-supply [--json]`: does every lane have work and usage left? Read-only. */
import { formatLaneSupply, type LaneSupplyReport } from '../core/fleet/lane-supply.js';

const USAGE = 'Usage: phm fleet lane-supply [--json]';
const HELP = `${USAGE}
Per lane: running of target, queued, pool used %, hours to reset and one verdict: busy, idle with usage left (the alarm), out of usage until <time>, held. Then the planner's last pass age and the last autofill decision from queue/self-tick-last.json. Reads ~/.ashlr-runs (override with ASHLR_RUNS_DIR). Read-only. Exit 1 when a lane is idle with usage left, so a script can alarm on it.`;

export async function cmdFleetLaneSupply(
  args: string[],
  read: () => Promise<LaneSupplyReport> = async () => (await import('../core/fleet/lane-supply-read.js')).readLaneSupply(),
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(HELP); return 0; }
  if (args.some(a => a !== '--json') || args.length > 1) { console.error(`error: invalid fleet lane-supply arguments\n${USAGE}`); return 2; }
  const report = await read();
  console.log(args.length ? JSON.stringify(report) : formatLaneSupply(report));
  return report.idle.length > 0 ? 1 : 0;
}
