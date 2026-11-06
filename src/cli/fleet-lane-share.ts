import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_LANE_SHARE_SCHEMA = 'fleet.lane-share.v1';
/** A lane with none running is marked starved once it has this many jobs queued. */
export const FLEET_LANE_SHARE_STARVED_QUEUED = 10;

export type FleetLaneShareMark = 'starved' | 'full';
export type FleetLaneShareStatus = 'ok' | 'red';

export interface FleetLaneShareLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  mark: FleetLaneShareMark | null;
  /** True when this starved lane sits behind an admission reason that starts with at_cap. */
  starvedAtCap: boolean;
}

export interface FleetLaneShareView {
  schema: typeof FLEET_LANE_SHARE_SCHEMA;
  readOnly: true;
  status: FleetLaneShareStatus;
  fleet: { running: number; cap: number };
  admissionReason: string | null;
  lanes: FleetLaneShareLane[];
}

export type FleetLaneShareReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet lane-share [--json]
Read queue/status.json and print each lane's share of the fleet: one line per lane with running of target and queued, then fleet running against the admission cap. Read-only.
A lane is marked starved when it has ${FLEET_LANE_SHARE_STARVED_QUEUED} or more queued and none running, full when its running equals its target; starved wins when both are true.
Exits 1 when a lane is starved while the admission reason starts with at_cap (queued work parked because the whole fleet is full). Unreadable status exits 2.
Related: ashlr fleet admission, ashlr fleet trim.`;

const UNREADABLE = 'Queue status is unreadable or invalid.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status');
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
  return value;
}

/** Drop control characters so a lane name or reason stays one plain line. */
function plain(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

function admitReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid admit reason');
  return plain(value) || null;
}

/** Starved outranks full: a lane parked with heavy backlog matters more than its bookkeeping target. */
export function laneMark(running: number, target: number, queued: number): FleetLaneShareMark | null {
  if (queued >= FLEET_LANE_SHARE_STARVED_QUEUED && running === 0) return 'starved';
  if (running === target) return 'full';
  return null;
}

/** Project only the fields the share view needs. Never copies the rest of the status file. */
export function explainFleetLaneShare(value: unknown): FleetLaneShareView {
  const status = record(value);
  const admission = record(status.admission);
  const cap = count(admission.cap);
  const reason = admitReason(admission.reason);
  const atCap = reason !== null && reason.startsWith('at_cap');
  const lanes = Object.entries(record(status.lanes)).map(([name, row]): FleetLaneShareLane => {
    const lane = plain(name);
    if (!lane) throw new Error('Invalid lane');
    const fields = record(row);
    const running = count(fields.running);
    const target = count(fields.target);
    const queued = count(fields.queued);
    const mark = laneMark(running, target, queued);
    return { lane, running, target, queued, mark, starvedAtCap: mark === 'starved' && atCap };
  });
  return {
    schema: FLEET_LANE_SHARE_SCHEMA,
    readOnly: true,
    status: lanes.some(lane => lane.starvedAtCap) ? 'red' : 'ok',
    fleet: { running: lanes.reduce((sum, lane) => sum + lane.running, 0), cap },
    admissionReason: reason,
    lanes,
  };
}

function formatFleetLaneShare(view: FleetLaneShareView): string {
  const lines = view.lanes.map(lane =>
    `${lane.lane}: ${lane.running} of ${lane.target} running, ${lane.queued} queued${lane.mark ? ` ${lane.mark}` : ''}`);
  lines.push(`fleet: ${view.fleet.running} running of cap ${view.fleet.cap}`);
  const starved = view.lanes.filter(lane => lane.starvedAtCap).map(lane => lane.lane);
  if (starved.length > 0) lines.push(`red: ${starved.join(', ')} starved while the admission reason starts with at_cap`);
  return lines.join('\n');
}

/** Read-only. The injected reader is the only filesystem operation. */
export async function cmdFleetLaneShare(
  args: string[],
  reader: FleetLaneShareReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  try {
    const view = sanitizePublicJson(explainFleetLaneShare(JSON.parse(
      await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')),
    ))) as FleetLaneShareView;
    console.log(args.includes('--json') ? JSON.stringify(view) : formatFleetLaneShare(view));
    return view.status === 'red' ? 1 : 0;
  } catch {
    const body = { schema: FLEET_LANE_SHARE_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
