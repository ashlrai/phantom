import { readTail } from '../core/metrics/loop-collect.js';
import { summarizeAdmission } from '../core/fleet/admission-summary.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleetAdmissionVerdict } from '../core/fleet/admission-verdict.js';
import { laneLaunchTarget } from '../core/fleet/lane-launch-target.js';
import { parseAdmissionCtl, type LoadAdmission } from '../core/fleet/load-owners.js';
import { readJobsTail } from '../core/fleet/report-ledger.js';
import { settleAdvice } from '../core/fleet/settle-advice.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** A lane parked by a fleet-wide block is red once it has this many jobs queued. */
export const FLEET_ADMISSION_RED_QUEUED = 5;
export const FLEET_ADMISSION_SCHEMA = 'fleet.admission.v1';

export type FleetAdmissionReason = 'held' | 'at target' | 'admission closed' | 'blocked by the global cap' | 'ok';
export type FleetAdmissionStatus = 'ok' | 'red';

export interface FleetAdmissionGlobal {
  cap: number;
  running: number;
  load1: number;
  admit_reason: string | null;
  /** True when global running is at or over the cap. */
  at_cap: boolean;
  /** True when the dispatcher admits no new claims this tick: at the cap, load gate tripped, or paused. */
  closed: boolean;
  /** True when admission is closed by the load gate or a pause rather than only the global cap. */
  non_cap_closed: boolean;
}

export interface FleetAdmissionLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
  target: number;
  queued: number;
  held: boolean;
  reason: FleetAdmissionReason;
  status: FleetAdmissionStatus;
}

export interface FleetAdmissionReport {
  admission?: ReturnType<typeof summarizeAdmission>;
  schema: typeof FLEET_ADMISSION_SCHEMA;
  readOnly: true;
  status: FleetAdmissionStatus;
  global: FleetAdmissionGlobal;
  lanes: FleetAdmissionLane[];
  launchGuard: LoadAdmission;
  settleAdvice: ReturnType<typeof settleAdvice>;
}

export type FleetAdmissionReader = (path: string) => Promise<string>;

const USAGE = `Usage: ashlr fleet admission [--json]
Read the global cap and why each lane is waiting. Read-only.
Shows the launch guard's settle seconds, host load and owned load separately.
Load-only settle advice uses the last 24 hours of metrics/fleet-controller.jsonl; incomplete history stays unknown. No limits or settings change.
A lane is admission closed when it has queued work, is under its launch target (the configured target tightened by the controller's effective_target shed), and the dispatcher is not admitting (load gate or pause).
A lane is blocked by the global cap when it has queued work, is under its launch target, and global running is at the cap while admission is otherwise open.
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

/** A count that stays unknown (null) instead of failing the whole report. */
function maybeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

/** The dispatcher's gate reasons, when present; anything else stays null. */
function gateReason(value: unknown): string | null {
  return typeof value === 'string' ? plain(value) || null : null;
}

/**
 * Held wins, then a full lane, then a fleet-wide admission block.
 * A non-cap block (load gate or pause) outranks the cap: freeing cap
 * cannot launch work while admission is closed. The cap applies only
 * when queued is above 0 and running is still under target.
 */
function laneReason(
  lane: { held: boolean; running: number; target: number; queued: number },
  atCap: boolean,
  nonCapClosed: boolean,
): FleetAdmissionReason {
  if (lane.held) return 'held';
  if (lane.running >= lane.target) return 'at target';
  if (lane.queued > 0 && lane.running < lane.target && nonCapClosed) return 'admission closed';
  if (lane.queued > 0 && lane.running < lane.target && atCap) return 'blocked by the global cap';
  return 'ok';
}

/** Reasons that park queued work fleet-wide; either is red past the queued threshold. */
function blockingReason(reason: FleetAdmissionReason): boolean {
  return reason === 'admission closed' || reason === 'blocked by the global cap';
}

/** Project the admission block and each lane. Never copies the rest of the status file. */
export function explainFleetAdmission(value: unknown, guard: string | null = null, history: string | null = null, now = Date.now()): FleetAdmissionReport {
  const status = record(value);
  const admission = record(status.admission);
  const cap = count(admission.cap);
  const running = count(admission.running);
  const atCap = running >= cap;
  const launchGuard = parseAdmissionCtl(guard);
  // Include the host guard's reported wait alongside the dispatcher verdict.
  const gate = gateReason(admission.gate_reason);
  const { closed, nonCapClosed } = fleetAdmissionVerdict({
    atCap, admit: admission.admit, decision: admission.decision,
    gateReason: gate ?? (launchGuard.state === 'waiting' ? launchGuard.why ?? 'settle' : null), paused: status.paused,
  });
  const lanes = Object.entries(record(status.lanes)).map(([name, row]): FleetAdmissionLane => {
    const lane = plain(name);
    if (!lane) throw new Error('Invalid lane');
    const fields = record(row);
    const laneRunning = count(fields.running);
    // A lane shed below its configured target is at its launch ceiling, not
    // under target: availability counts against effective_target.
    const target = laneLaunchTarget(count(fields.target), maybeCount(fields.effective_target));
    const queued = count(fields.queued);
    if (typeof fields.held !== 'boolean') throw new Error('Invalid hold');
    const reason = laneReason({ held: fields.held, running: laneRunning, target, queued }, atCap, nonCapClosed);
    return {
      lane, running: laneRunning, target, queued, held: fields.held, reason,
      status: blockingReason(reason) && queued >= FLEET_ADMISSION_RED_QUEUED ? 'red' : 'ok',
    };
  });
  return {
    schema: FLEET_ADMISSION_SCHEMA,
    readOnly: true,
    status: lanes.some(lane => lane.status === 'red') ? 'red' : 'ok',
    global: {
      cap, running, load1: load(admission.load1), admit_reason: admitReason(admission.reason), at_cap: atCap,
      closed, non_cap_closed: nonCapClosed,
    },
    lanes,
    launchGuard,
    settleAdvice: settleAdvice(history, now),
  };
}

function formatFleetAdmission(report: FleetAdmissionReport): string {
  const global = report.global;
  const guard = report.launchGuard, advice = report.settleAdvice;
  const lines = [
    ...(report.admission ? [report.admission.answer] : []),
    `Admission: ${report.status}`,
    `Global cap ${global.cap}, running ${global.running} (${global.at_cap ? 'at the cap' : 'under the cap'})${global.non_cap_closed ? ', admission closed' : ''}, load ${global.load1}, admit reason: ${global.admit_reason ?? 'none'}`,
    `Launch guard: ${guard.state}; reason: ${guard.why ?? 'unknown'}; settle: ${guard.settleSeconds ?? 'unknown'} seconds; host load: ${guard.load1 ?? 'unknown'}; owned load: ${guard.ownedLoad1 ?? 'unknown'}.`,
    `Suggested settle: ${advice.recommendedSeconds ?? 'unknown'} seconds (${advice.hoursCovered}/24 hours observed). ${advice.reason} No settings changed.`,
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
  reader?: FleetAdmissionReader,
  now = Date.now(),
  tailReader: typeof readTail = readTail,
): Promise<number> {
  const read = reader ?? (async (path: string) => {
    if (path.endsWith('dispatchd.log')) {
      const tail = await tailReader(path, 256 * 1024);
      if (!tail) throw new Error('Log unavailable');
      return tail.text;
    }
    return path.endsWith('fleet-controller.jsonl') ? (await readJobsTail(path)).text ?? '' : readFile(path, 'utf8');
  });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  try {
    const root = join(homedir(), '.ashlr-runs');
    const optional = (path: string) => read(join(root, path)).catch(() => null);
    const [status, guard, history, log] = await Promise.all([
      read(join(root, 'queue/status.json')), optional('queue/admission-ctl.json'), optional('metrics/fleet-controller.jsonl'), optional('dispatchd.log'),
    ]);
    const report = explainFleetAdmission(JSON.parse(status), guard, history, now);
    const targets = Object.fromEntries(report.lanes.map(lane => [lane.lane, { target: lane.target }]));
    report.admission = summarizeAdmission(guard, log, now, targets);
    const safeReport = sanitizePublicJson(report) as FleetAdmissionReport;
    console.log(args.includes('--json') ? JSON.stringify(safeReport) : formatFleetAdmission(safeReport));
    return report.status === 'red' ? 1 : 0;
  } catch {
    const body = { schema: FLEET_ADMISSION_SCHEMA, readOnly: true, error: UNREADABLE };
    console.log(args.includes('--json') ? JSON.stringify(body) : UNREADABLE);
    return 2;
  }
}
