/** Per-lane engineering console, including launch-file hold evidence. */
import { isAbsolute } from 'node:path';
import { formatFleetLanes as formatBase } from './fleet.js';
import { getFleetLaneSnapshot, type FleetLaneSnapshot } from '../core/fleet/lane-console.js';

const usage = 'Usage: phm fleet lanes [--json] [--queue-dir <abs>]';

export function formatFleetLanes(snapshot: FleetLaneSnapshot): string {
  const held = snapshot.lanes.flatMap(lane => lane.held ? [
    `  HELD ${lane.lane}: ${lane.held.reason} · ${lane.held.launches_held_1h} held in the last hour · since ${lane.held.since}`,
    `    Next: ${lane.held.next_step}`,
  ] : []);
  return [formatBase(snapshot), ...held].join('\n');
}

export async function cmdFleetLanes(args: string[], read = getFleetLaneSnapshot): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let queueDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] !== '--queue-dir' || !args[i + 1] || !isAbsolute(args[i + 1]!)) { console.error(usage); return 2; }
    queueDir = args[++i];
  }
  try {
    const snapshot = await read(queueDir ? { queueDir } : {});
    console.log(args.includes('--json') ? JSON.stringify(snapshot) : formatFleetLanes(snapshot));
    return 0;
  } catch { console.error('error: fleet lanes failed; check the queue directory'); return 1; }
}
