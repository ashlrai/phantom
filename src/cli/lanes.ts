import { readFleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../core/fleet/lane-health.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm lanes --json | phm lanes health [--json]
Calls, error rate, p50 latency and deployed commit per lane over the last 12 h,
plus a "stuck" badge with phase age for any run past its phase timeout.
Figures that cannot be measured print "unknown".`;

export async function cmdLanes(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--json') {
    const state = await readFleetRunsDirState();
    console.log(JSON.stringify(sanitizePublicJson({ schema: 'lanes.dispatchd.v1', lastTick: state.lastTick,
      sourceState: state.sources.status, lanes: state.lanes })));
    return 0;
  }
  if (args.length === 0 || ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] !== 'health' || args.slice(1).some((a) => a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const { snapshot } = await buildFleetLiveSnapshot();
  const health = computeLaneHealth(snapshot);
  if (args.includes('--json')) {
    console.log(JSON.stringify(sanitizePublicJson(health)));
    return 0;
  }
  console.log(`Lane health, last ${health.window.hours} h (to ${health.window.until})`);
  for (const lane of health.lanes) {
    const badge = stuckBadge(lane);
    console.log(`${lane.lane}: ${laneHealthLine(lane)}${badge ? `  [${badge}]` : ''}`);
  }
  return 0;
}
