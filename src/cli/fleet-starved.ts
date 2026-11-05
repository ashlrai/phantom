import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_STARVED_SCHEMA = 'fleet.starved.v1';
/** A lane with none running turns the view red once it has this many jobs queued. */
export const FLEET_STARVED_RED_QUEUED = 10;

export type FleetStarvedStatus = 'ok' | 'red';

export interface FleetStarvedLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  /** True when running is below target while the admission reason starts with at_cap. */
  starved: boolean;
  /** True when the lane has FLEET_STARVED_RED_QUEUED or more queued and none running. */
  backlogged: boolean;
}

export interface FleetStarvedView {
  schema: typeof FLEET_STARVED_SCHEMA;
  readOnly: true;
  status: FleetStarvedStatus;
  admission: {
    running: number;
    cap: number;
    reason: string | null;
    /** True when the admission reason starts with at_cap. */
    atCap: boolean;
  };
  /** Only lanes that still have queued work. */
  lanes: FleetStarvedLane[];
}

export type FleetStarvedReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet starved [--json]
Read queue/status.json and print one plain line per lane that still has queued work: running of target, queued, marked starved when running is below target while the admission reason starts with at_cap, then the admission running, cap and reason. Read-only.
Exits 1 when any lane has ${FLEET_STARVED_RED_QUEUED} or more queued and none running. Unreadable status exits 2.
Related: ashlr fleet lane-share, ashlr fleet admission.`;

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

/** Project only the lanes with queued work plus the admission verdict. Never copies the rest of the status file. */
export function explainFleetStarved(value: unknown): FleetStarvedView {
  const status = record(value);
  const admission = record(status.admission);
  const cap = count(admission.cap);
  const running = count(admission.running);
  const reason = admitReason(admission.reason);
  const atCap = reason !== null && reason.startsWith('at_cap');
  const lanes = Object.entries(record(status.lanes)).flatMap(([name, row]): FleetStarvedLane[] => {
    const lane = plain(name);
    if (!lane) throw new Error('Invalid lane');
    const fields = record(row);
    const laneRunning = count(fields.running);
    const target = count(fields.target);
    const queued = count(fields.queued);
    if (queued === 0) return [];
    return [{
      lane, running: laneRunning, target, queued,
      starved: laneRunning < target && atCap,
      backlogged: queued >= FLEET_STARVED_RED_QUEUED && laneRunning === 0,
    }];
  });
  return {
    schema: FLEET_STARVED_SCHEMA,
    readOnly: true,
    status: lanes.some(lane => lane.backlogged) ? 'red' : 'ok',
    admission: { running, cap, reason, atCap },
    lanes,
  };
}

function formatFleetStarved(view: FleetStarvedView): string {
  const lines = view.lanes.map(lane =>
    `${lane.lane}: ${lane.running} of ${lane.target} running, ${lane.queued} queued${lane.starved ? ' starved' : ''}`);
  const admission = view.admission;
  lines.push(`admission: ${admission.running} running of cap ${admission.cap}, reason: ${admission.reason ?? 'none'}`);
  return lines.join('\n');
}

/** Read-only. The injected reader is the only filesystem operation. */
export async function cmdFleetStarved(
  args: string[],
  reader: FleetStarvedReader = path => readFile(path, 'utf8'),
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
    const view = sanitizePublicJson(explainFleetStarved(JSON.parse(
      await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')),
    ))) as FleetStarvedView;
    console.log(args.includes('--json') ? JSON.stringify(view) : formatFleetStarved(view));
    return view.status === 'red' ? 1 : 0;
  } catch {
    const body = { schema: FLEET_STARVED_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
