import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { LANE_HOLDS_PATH } from '../fleet-lanes/lane-hold-release.js';
import { isLaneTargets, type LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { holdClearsIn, holdReleasable } from './lane-target-model.js';

export const needsHoldsQuery: QueryDef<LaneTargetsV1> = {
  key: 'mobile-fleet-holds',
  async fetch(signal) {
    const value = await apiGet<unknown>(LANE_HOLDS_PATH, signal);
    if (!isLaneTargets(value)) throw new Error('Invalid lane holds response.');
    return value;
  },
};

export function heldLaneItems(targets: LaneTargetsV1 | null, nowMs: number): Array<{
  lane: string; title: string; subtitle: string; releasable: boolean;
}> {
  return (targets?.lanes ?? []).filter((row) => row.held).map((row) => {
    const clears = row.heldUntil ? holdClearsIn(row.heldUntil, nowMs) : null;
    const expiry = clears ? `clears ${clears}` : row.heldUntil ? 'clear time unavailable' : 'no end set';
    return {
      lane: row.lane,
      title: `${row.lane} is held`,
      subtitle: `${row.heldReason || 'reason unavailable'} · ${expiry}`,
      releasable: holdReleasable({ ...row, running: null, queued: null, pausedFrom: row.pausedFrom ?? null, writable: false }),
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
}
