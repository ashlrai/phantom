import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { LANE_HOLDS_PATH } from '../fleet-lanes/lane-hold-release.js';
import { isLaneTargets, type LaneTargetRow, type LaneTargetsV1 } from '../ops/lane-targets-model.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';

export const laneHoldsQuery: QueryDef<LaneTargetsV1 | null> = {
  key: 'verse-fleet-queue-holds',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(LANE_HOLDS_PATH, signal);
      if (!isLaneTargets(value)) throw new Error('Invalid lane holds response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export function heldLaneLine(row: LaneTargetRow | undefined, nowMs: number): string | null {
  if (!row?.held) return null;
  const expiry = row.heldUntil ? Date.parse(row.heldUntil) : NaN;
  if (!Number.isFinite(expiry)) return `held: ${row.heldReason || 'reason unavailable'} · no end set`;
  const minutes = Math.max(0, Math.ceil((expiry - nowMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  const duration = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
  return `held: ${row.heldReason || 'reason unavailable'} · clears in ${duration}`;
}

export function queuedBehindHold(groups: FleetQueueV1['byLane'], holds: LaneTargetsV1 | null | undefined): number {
  const held = new Set(holds?.lanes.filter((lane) => lane.held).map((lane) => lane.lane));
  return groups.reduce((total, group) => total + (held.has(group.lane) ? group.ready : 0), 0);
}
