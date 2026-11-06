import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

export type LaneIdleReader = (path: string) => Promise<string>;
export interface IdleLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  reason: 'held' | 'nothing queued' | 'admission closed' | 'queued work not launching';
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
  const gate = typeof admission.gate_reason === 'string' ? plain(admission.gate_reason) : null;
  const closed = admission.admit === false || admission.decision === 'stop' || Boolean(gate) || Boolean(status.paused);
  return Object.entries(lanes).flatMap(([name, value]) => {
    const lane = record(value);
    const running = count(lane.running), target = count(lane.target), queued = count(lane.queued);
    if (typeof lane.held !== 'boolean') throw new Error('Invalid hold');
    if (running >= target) return [];
    const reason = lane.held ? 'held' : queued === 0 ? 'nothing queued'
      : closed ? 'admission closed' : 'queued work not launching';
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
    console.log('Usage: ashlr fleet lane-idle [--json]\nExplain why lanes are below target from queue/status.json. Read-only.');
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
