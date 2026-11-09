/**
 * Consumer for usage.sensors.v1 (phm usage sensors --json).
 * Headroom is null unless the reading is fresh and both ends were measured.
 * A stale number is not room and is not shown as a live used or limit.
 */
import type { UsageWindow } from './types.js';

const LANES = ['devin', 'codex-cmp', 'codex-personal', 'claude-max', 'grok-ultra', 'terra'] as const;
const STALE_MS = 15 * 60_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function fresh(observedAt: string | null, staleAfter: string | null, nowMs: number): boolean {
  if (observedAt === null || !Number.isFinite(nowMs)) return false;
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed > nowMs) return false;
  const deadline = staleAfter === null ? observed + STALE_MS : Date.parse(staleAfter);
  return Number.isFinite(deadline) && nowMs < deadline;
}

function windowFrom(raw: Record<string, unknown>, nowMs: number): UsageWindow | null {
  const lane = typeof raw['lane'] === 'string' ? raw['lane'] : null;
  if (!lane) return null;
  const observedAt = iso(raw['observedAt']);
  const staleAfter = iso(raw['staleAfter']);
  const source = typeof raw['source'] === 'string' ? raw['source'] : null;
  const statusField = raw['status'] === 'fresh' || raw['status'] === 'unknown' ? raw['status'] : null;
  const measuredFresh = statusField === 'fresh' || (statusField === null && fresh(observedAt, staleAfter, nowMs) && source !== 'unmeasured');
  const used = measuredFresh ? finite(raw['used']) : null;
  const limit = measuredFresh ? finite(raw['limit']) : null;
  const headroomField = raw['headroom'];
  const headroom = !measuredFresh || headroomField === null || used === null || limit === null
    ? null
    : finite(headroomField) ?? Math.max(0, limit - used);
  const priorUsed = finite(raw['priorUsed']);
  const priorAt = iso(raw['priorObservedAt']);
  let burnPerHour: number | null = null;
  if (measuredFresh && used !== null && priorUsed !== null && priorAt !== null && observedAt !== null) {
    const hours = (Date.parse(observedAt) - Date.parse(priorAt)) / 3_600_000;
    if (hours > 0 && used >= priorUsed) burnPerHour = (used - priorUsed) / hours;
  }
  const resetAt = measuredFresh ? iso(raw['resetAt']) : null;
  let projectedUnused: number | null = null;
  let alert: UsageWindow['alert'] = null;
  if (burnPerHour !== null && used !== null && limit !== null && resetAt !== null) {
    const hoursLeft = (Date.parse(resetAt) - nowMs) / 3_600_000;
    if (hoursLeft > 0) {
      projectedUnused = limit - (used + burnPerHour * hoursLeft);
      if (projectedUnused > 0) alert = 'unused-before-reset';
    }
  }
  return {
    lane,
    status: measuredFresh && headroom !== null ? 'fresh' : 'unknown',
    headroom: measuredFresh ? headroom : null,
    used, limit,
    unit: measuredFresh && (raw['unit'] === 'percent' || raw['unit'] === 'acu') ? raw['unit'] : null,
    resetAt, observedAt, source, staleAfter, burnPerHour, projectedUnused, alert,
  };
}

/** Project a sensors report or a readings array. Invalid input is an empty unknown list. */
export function projectSensors(raw: unknown, nowMs: number): UsageWindow[] {
  const body = record(raw);
  if (!body) return [];
  const rows = Array.isArray(body['lanes']) ? body['lanes']
    : Array.isArray(body['readings']) ? body['readings']
    : Array.isArray(raw) ? raw as unknown[] : [];
  const byLane = new Map<string, UsageWindow>();
  for (const row of rows) {
    const rec = record(row);
    if (!rec) continue;
    const view = windowFrom(rec, nowMs);
    if (view) byLane.set(view.lane, view);
  }
  if (byLane.size === 0) return [];
  const ordered = LANES.filter((lane) => byLane.has(lane)).map((lane) => byLane.get(lane)!);
  for (const [lane, view] of byLane) if (!LANES.includes(lane as typeof LANES[number])) ordered.push(view);
  return ordered;
}
