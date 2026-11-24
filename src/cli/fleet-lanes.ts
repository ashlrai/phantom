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
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--queue-dir') {
      const value = args[i + 1];
      if (!value || !isAbsolute(value)) {
        process.stderr.write('error: fleet lanes: --queue-dir requires an absolute path\n');
        return 2;
      }
      queueDir = value;
      i++;
      continue;
    }
    process.stderr.write(`error: fleet lanes: unknown option ${arg}\n`);
    return 2;
  }
  try {
    const snapshot = await read(queueDir ? { queueDir } : {});
    console.log(args.includes('--json') ? JSON.stringify(snapshot) : formatFleetLanes(snapshot));
    return 0;
  } catch { console.error('error: fleet lanes failed; check the queue directory'); return 1; }
}
