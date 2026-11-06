import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** A lane blocked by the global cap is red once it has this many jobs queued. */
export const FLEET_ADMISSION_RED_QUEUED = 5;
export const FLEET_ADMISSION_SCHEMA = 'fleet.admission.v1';

export type FleetAdmissionReason = 'held' | 'at target' | 'blocked by the global cap' | 'ok';
export type FleetAdmissionStatus = 'ok' | 'red';

export interface FleetAdmissionGlobal {
  cap: number;
  running: number;
  load1: number;
  admit_reason: string | null;
  /** True when global running is at or over the cap. */
  at_cap: boolean;
}

export interface FleetAdmissionLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
  reason: FleetAdmissionReason;
  status: FleetAdmissionStatus;
}

export interface FleetAdmissionReport {
  schema: typeof FLEET_ADMISSION_SCHEMA;
  readOnly: true;
  status: FleetAdmissionStatus;
  global: FleetAdmissionGlobal;
  lanes: FleetAdmissionLane[];
}

export type FleetAdmissionReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet admission [--json]
Read the global cap and why each lane is waiting. Read-only.
A lane is blocked by the global cap when it has queued work, is under its target, and global running is at the cap.
Exits 1 when any such lane has ${FLEET_ADMISSION_RED_QUEUED} or more queued.
Other waits: ashlr fleet lane-idle.`;

const UNREADABLE = 'Queue status is unreadable or invalid.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid status');
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
  return value;
}

function load(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid load');
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

/**
 * Held wins, then a full lane, then the global cap.
 * The cap applies only when queued is above 0 and running is still under target.
 */
function laneReason(
  lane: { held: boolean; running: number; target: number; queued: number },
  atCap: boolean,
): FleetAdmissionReason {
  if (lane.held) return 'held';
  if (lane.running >= lane.target) return 'at target';
  if (lane.queued > 0 && lane.running < lane.target && atCap) return 'blocked by the global cap';
  return 'ok';
}

/** Project the admission block and each lane. Never copies the rest of the status file. */
export function explainFleetAdmission(value: unknown): FleetAdmissionReport {
  const status = record(value);
  const admission = record(status.admission);
  const cap = count(admission.cap);
  const running = count(admission.running);
  const atCap = running >= cap;
  const lanes = Object.entries(record(status.lanes)).map(([name, row]): FleetAdmissionLane => {
    const lane = plain(name);
    if (!lane) throw new Error('Invalid lane');
    const fields = record(row);
    const laneRunning = count(fields.running);
    const target = count(fields.target);
    const queued = count(fields.queued);
    if (typeof fields.held !== 'boolean') throw new Error('Invalid hold');
    const reason = laneReason({ held: fields.held, running: laneRunning, target, queued }, atCap);
    return {
      lane, running: laneRunning, target, queued, held: fields.held, reason,
      status: reason === 'blocked by the global cap' && queued >= FLEET_ADMISSION_RED_QUEUED ? 'red' : 'ok',
    };
  });
  return {
    schema: FLEET_ADMISSION_SCHEMA,
    readOnly: true,
    status: lanes.some(lane => lane.status === 'red') ? 'red' : 'ok',
    global: { cap, running, load1: load(admission.load1), admit_reason: admitReason(admission.reason), at_cap: atCap },
    lanes,
  };
}

function formatFleetAdmission(report: FleetAdmissionReport): string {
  const global = report.global;
  const lines = [
    `Admission: ${report.status}`,
    `Global cap ${global.cap}, running ${global.running} (${global.at_cap ? 'at the cap' : 'under the cap'}), load ${global.load1}, admit reason: ${global.admit_reason ?? 'none'}`,
  ];
  if (report.lanes.length === 0) lines.push('No lanes.');
  for (const lane of report.lanes) {
    lines.push(`${lane.status} ${lane.lane}: ${lane.reason}. Running ${lane.running} of ${lane.target}. Queued ${lane.queued}. Held ${lane.held ? 'yes' : 'no'}.`);
  }
  return lines.join('\n');
}

/** Read-only. The injected reader is the only filesystem operation. */
export async function cmdFleetAdmission(
  args: string[],
  reader: FleetAdmissionReader = path => readFile(path, 'utf8'),
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
    const report = sanitizePublicJson(explainFleetAdmission(JSON.parse(
      await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json')),
    ))) as FleetAdmissionReport;
    console.log(args.includes('--json') ? JSON.stringify(report) : formatFleetAdmission(report));
    return report.status === 'red' ? 1 : 0;
  } catch {
    const body = { schema: FLEET_ADMISSION_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
