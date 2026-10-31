export interface LaneTargetRow {
  lane: string;
  target: number;
  floor: number;
  ceiling: number;
  held: boolean;
  heldReason: string | null;
  heldUntil: string | null;
  lastChange: string | null;
  changedBy: string | null;
}

export interface LaneTargetsV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  lanes: LaneTargetRow[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

export function isLaneTargets(value: unknown): value is LaneTargetsV1 {
  return record(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && (value.sourceState === 'healthy' || value.sourceState === 'missing' || value.sourceState === 'degraded')
    && Array.isArray(value.lanes) && value.lanes.every((row: unknown) => record(row)
      && typeof row.lane === 'string' && Number.isSafeInteger(row.target)
      && Number.isSafeInteger(row.floor) && Number.isSafeInteger(row.ceiling)
      && typeof row.held === 'boolean' && nullableString(row.heldReason)
      && nullableString(row.heldUntil) && nullableString(row.lastChange) && nullableString(row.changedBy));
}

export function stepAllowed(row: LaneTargetRow, delta: number): boolean {
  const next = row.target + delta;
  return (delta === -1 || delta === 1) && next >= row.floor && next <= row.ceiling;
}

export function captionFor(row: LaneTargetRow, nowMs: number): string {
  if (row.held) return `held: ${row.heldReason || 'reason unavailable'}`;
  if (!row.lastChange) return '';
  const time = Date.parse(row.lastChange);
  if (!Number.isFinite(time) || time > nowMs) return '';
  const minutes = Math.floor((nowMs - time) / 60_000);
  const age = minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes} min`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} hr` : `${Math.floor(minutes / 1440)} d`;
  return `changed ${age} ago${row.changedBy ? ` by ${row.changedBy}` : ''}`;
}
