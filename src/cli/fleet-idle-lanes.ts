import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { IDLE_LANES_SCHEMA, parseIdleLanes } from '../core/fleet/idle-lanes.js';
export type { IdleLane } from '../core/fleet/idle-lanes.js';

export type IdleLaneReader = (path: string) => Promise<string>;

/** Read dispatcher observations only; never change holds or launch work. */
export async function cmdFleetIdleLanes(
  args: string[],
  reader: IdleLaneReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet idle-lanes [--json]\nRead lanes with queued work. Red: room to run. Warn: held. Exit 1 if any lane is red.');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  try {
    const lanes = parseIdleLanes(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    console.log(args.includes('--json') ? JSON.stringify({ schema: IDLE_LANES_SCHEMA, lanes })
      : lanes.map(lane => `${lane.status}: ${lane.lane}: ${lane.running}/${lane.target} running, ${lane.queued} queued`).join('\n') || 'No idle lanes with queued work.');
    return lanes.some(lane => lane.status === 'red') ? 1 : 0;
  } catch {
    const error = 'Cannot read lane status. Expected lanes with held, running, target and queued in ~/.ashlr-runs/queue/status.json.';
    console.log(args.includes('--json') ? JSON.stringify({ schema: IDLE_LANES_SCHEMA, error }) : error);
    return 2;
  }
}
