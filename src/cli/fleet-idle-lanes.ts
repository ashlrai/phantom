import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface IdleLane {
  lane: string;
  status: 'red' | 'warn';
  running: number;
  target: number;
  queued: number;
}
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
    const data: unknown = JSON.parse(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
    const lanes: IdleLane[] = [];
    for (const [lane, value] of Object.entries(data.lanes)) {
      if (!isRecord(value) || typeof value.held !== 'boolean'
        || ![value.running, value.target, value.queued].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
        throw new Error('invalid lane');
      }
      const { running, target, queued } = value as { running: number; target: number; queued: number };
      if (queued > 0 && (value.held || running < target)) {
        lanes.push({ lane, status: value.held ? 'warn' : 'red', running, target, queued });
      }
    }
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.idle-lanes.v1', lanes })
      : lanes.map(lane => `${lane.status}: ${lane.lane}: ${lane.running}/${lane.target} running, ${lane.queued} queued`).join('\n') || 'No idle lanes with queued work.');
    return lanes.some(lane => lane.status === 'red') ? 1 : 0;
  } catch {
    const error = 'Cannot read lane status. Expected lanes with held, running, target and queued in ~/.ashlr-runs/queue/status.json.';
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.idle-lanes.v1', error }) : error);
    return 2;
  }
}
