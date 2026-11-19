import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleetAdmissionVerdict } from '../core/fleet/admission-verdict.js';
import { laneLaunchTarget } from '../core/fleet/lane-launch-target.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet lane-idle [--json]
Explain why lanes are below their launch target (the configured target tightened by the controller's effective_target shed) from queue/status.json. Read-only.
A lane is blocked by the global cap when it has queued work, is under its launch target, and global running is at the cap while admission is otherwise open.`;

export type LaneIdleReader = (path: string) => Promise<string>;
export type LaneIdleReason = 'held' | 'nothing queued' | 'admission closed' | 'blocked by the global cap' | 'queued work not launching';
export interface IdleLane {
  lane: string;
  running: number;
  /** The launch target: configured target tightened by the controller's effective_target shed. */
  target: number;
  queued: number;
  reason: LaneIdleReason;
  gate_reason: string | null;
  line: string;
}

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
function plain(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

/** Project only idle-lane metadata; never expose unrelated status-file contents. */
export function explainIdleLanes(value: unknown): IdleLane[] {
  const status = record(value);
  const lanes = record(status.lanes);
  const admission = status.admission === undefined ? {} : record(status.admission);
  const gate = typeof admission.gate_reason === 'string' ? plain(admission.gate_reason) || null : null;
  // The same fleet verdict fleet admission derives; a missing or malformed cap
  // block leaves the cap unknown rather than inventing a block.
  const cap = maybeCount(admission.cap);
  const fleetRunning = maybeCount(admission.running);
  const atCap = cap !== null && fleetRunning !== null && fleetRunning >= cap;
  const { nonCapClosed } = fleetAdmissionVerdict({
    atCap, admit: admission.admit, decision: admission.decision, gateReason: gate, paused: status.paused,
  });
  return Object.entries(lanes).flatMap(([name, value]) => {
    const lane = record(value);
    const running = count(lane.running), queued = count(lane.queued);
    // Availability counts against the launch target, not the configured one:
    // a lane the controller shed has no phantom room below it.
    const target = laneLaunchTarget(count(lane.target), maybeCount(lane.effective_target));
    if (typeof lane.held !== 'boolean') throw new Error('Invalid hold');
    if (running >= target) return [];
    const reason = lane.held ? 'held' : queued === 0 ? 'nothing queued'
      : nonCapClosed ? 'admission closed'
      : atCap ? 'blocked by the global cap'
      : 'queued work not launching';
    const gate_reason = reason === 'admission closed' ? gate : null;
    const label = plain(name);
    return [{ lane: label, running, target, queued, reason, gate_reason,
      line: `${label}: ${reason}${gate_reason ? ` (${gate_reason})` : ''}` }];
  });
}

/** Read-only: the injected reader is the command's only filesystem operation. */
export async function cmdFleetLaneIdle(
  args: string[],
  reader: LaneIdleReader = path => readFile(path, 'utf8'),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  try {
    const lanes = explainIdleLanes(JSON.parse(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json'))));
    console.log(args.includes('--json')
      ? JSON.stringify(sanitizePublicJson({ schema: 'fleet.lane-idle.v1', readOnly: true, lanes }))
      : sanitizePublicJson(lanes.map(lane => lane.line).join('\n') || 'No lanes below target.'));
    return 0;
  } catch {
    const error = 'Queue status unavailable or invalid.';
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.lane-idle.v1', readOnly: true, error }) : error);
    return 1;
  }
}
