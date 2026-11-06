export interface IdleLane {
  lane: string;
  status: 'red' | 'warn';
  running: number;
  target: number;
  queued: number;
}

export const IDLE_LANES_SCHEMA = 'fleet.idle-lanes.v1';

/** Parse dispatcher observations without I/O. */
export function parseIdleLanes(statusJson: string): IdleLane[] {
  const data: unknown = JSON.parse(statusJson);
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
  return lanes;
}
