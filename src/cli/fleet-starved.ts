import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StarvedLane, StarvedRead } from '../core/fleet/lane-starved.js';
import { laneLaunchTarget } from '../core/fleet/lane-launch-target.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const FLEET_STARVED_SCHEMA = 'fleet.starved.v1';
/** A lane with none running turns the view red once it has this many jobs queued. */
export const FLEET_STARVED_RED_QUEUED = 10;

export type FleetStarvedStatus = 'ok' | 'red';

/** A lane with free slots and nothing ready to run on them (RQ-STARVEN20MQ8). */
export interface FleetStarvedIdleLane extends StarvedLane { lane: string; line: string }

export interface FleetStarvedLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
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
  /** Lanes with free slots and no ready rows, most free slots first; null when the lanes read failed. */
  starved_lanes: FleetStarvedIdleLane[] | null;
  /** READY rows waiting on a held or drained pool that a starved lane could run instead. */
  waiting_elsewhere: number;
  /** Lane-open READY rows — open supply any lane may claim; null when the lanes read failed. */
  open_rows: number | null;
}

export type FleetStarvedReader = (path: string) => Promise<string>;
/** The lanes read's `starved` object; null when it cannot be read. */
export type FleetStarvedLanesReader = () => Promise<StarvedRead | null>;

const USAGE = `Usage: ashlr fleet starved [--json]
Name lanes with free slots and no ready rows ("claude: 8 free slots, 0 ready rows for 42 min; next step: add work for claude"), count the READY rows waiting on a held or drained pool, then read queue/status.json and print one plain line per lane that still has queued work: running of target, queued, marked starved when running is below target while the admission reason starts with at_cap, then the admission running, cap and reason. Target is the launch target: the configured target tightened by the controller's effective_target shed. Read-only; the queue is never written.
Exits 1 when any lane has ${FLEET_STARVED_RED_QUEUED} or more queued and none running, or when a lane has free slots and no ready rows. Unreadable status exits 2.
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

/** A count that stays unknown (null) instead of failing the whole report. */
function maybeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

/** Starved lanes (free slots, no ready rows) from the lanes read, biggest gap first. */
export function idleStarved(read: StarvedRead | null): Pick<FleetStarvedView, 'starved_lanes' | 'waiting_elsewhere' | 'open_rows'> {
  if (read === null) return { starved_lanes: null, waiting_elsewhere: 0, open_rows: null };
  const starved_lanes = Object.entries(read.lanes)
    .flatMap(([lane, row]) => row.starved && row.line !== null ? [{ ...row, lane: plain(lane), line: plain(row.line) }] : [])
    .sort((a, b) => (b.free_slots ?? 0) - (a.free_slots ?? 0) || a.lane.localeCompare(b.lane));
  return { starved_lanes, waiting_elsewhere: read.waiting_elsewhere, open_rows: read.open_rows ?? null };
}

/** Project only the lanes with queued work plus the admission verdict. Never copies the rest of the status file. */
export function explainFleetStarved(value: unknown, idle: StarvedRead | null = null): FleetStarvedView {
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
    // The launch target is the configured target tightened by the controller's
    // effective_target shed; a shed lane has no phantom room below it.
    const target = laneLaunchTarget(count(fields.target), maybeCount(fields.effective_target));
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
    ...idleStarved(idle),
  };
}

function formatFleetStarved(view: FleetStarvedView): string {
  const idle = view.starved_lanes ?? [];
  const lines = idle.map(row => row.line);
  if (idle.length > 0 && view.waiting_elsewhere > 0) {
    lines.push(`${view.waiting_elsewhere} READY ${view.waiting_elsewhere === 1 ? 'row is' : 'rows are'} waiting on a held or drained pool and could run on a starved lane instead.`);
  }
  lines.push(...view.lanes.map(lane =>
    `${lane.lane}: ${lane.running} of ${lane.target} running, ${lane.queued} queued${lane.starved ? ' starved' : ''}`));
  const admission = view.admission;
  lines.push(`admission: ${admission.running} running of cap ${admission.cap}, reason: ${admission.reason ?? 'none'}`);
  return lines.join('\n');
}

const defaultLanesReader: FleetStarvedLanesReader = async () => (await (await import('../core/fleet/lane-console.js')).getFleetLaneSnapshot()).starved;

/** Read-only. The injected readers are the only filesystem operations. */
export async function cmdFleetStarved(
  args: string[],
  reader: FleetStarvedReader = path => readFile(path, 'utf8'),
  lanes: FleetStarvedLanesReader = defaultLanesReader,
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
    const status = JSON.parse(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')));
    const view = sanitizePublicJson(explainFleetStarved(status, await lanes().catch(() => null))) as FleetStarvedView;
    console.log(args.includes('--json') ? JSON.stringify(view) : formatFleetStarved(view));
    return view.status === 'red' || (view.starved_lanes?.length ?? 0) > 0 ? 1 : 0;
  } catch {
    const body = { schema: FLEET_STARVED_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
