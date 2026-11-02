/**
 * core/fleet/lane-auto-hold.ts — turn lane-streak verdicts into bounded hold
 * decisions. Pure: no IO, no mutation, no dispatch authority. Backs
 * `ashlr fleet lane-autohold` (src/cli/fleet-lane-autohold.ts), which is the
 * action half of `fleet lane-streaks` detection: a lane whose launches all
 * end empty is burning queued jobs, so a candidate earns a self-expiring
 * hold — never a target change, never a loop.
 *
 * A lane is a candidate only when its verdict is `burning` and it has at
 * least `minEmpties` empty terminals (default 4 — one more than the streak
 * detector's 3-launch floor, so a fresh streak alone never trips it).
 * Candidates are refused, worst first:
 *
 *   fleet-wide    more than half of the lanes with launches in the window
 *                 are burning: a shared cause (red master, full disk) is
 *                 not a lane fault, and a mass hold would stop the fleet —
 *                 every candidate reports this reason so the signal is
 *                 unambiguous
 *   already-held  the lane row is held — refresh is placeLaneHold's job,
 *                 not this planner's
 *   target-zero   the lane is paused; a hold adds nothing
 *   no-target     the lane has launches but no slots.json row at all
 *   over-cap      at most `maxHolds` (default 2) holds per run
 *
 * Sort order is most empties first, then lane name — the lane hurting most
 * wins the cap.
 */
import type { LaneEmptyStreaksV1 } from './lane-empty-streak.js';
import type { LaneTargetsV1 } from './runs-lane-targets.js';

export const LANE_AUTOHOLD_MIN_EMPTIES = 4;
export const LANE_AUTOHOLD_MAX_HOLDS = 2;

export type LaneAutoHoldSkipReason =
  'already-held' | 'target-zero' | 'no-target' | 'fleet-wide' | 'over-cap';

export interface LaneAutoHoldDecision {
  lane: string;
  action: 'hold' | 'skip';
  /** Skip reason when action is 'skip'; null for a hold. */
  reason: LaneAutoHoldSkipReason | null;
  launches: number;
  empties: number;
}

export interface LaneAutoHoldOptions {
  /** Minimum empty terminals for a burning lane to be a candidate. */
  minEmpties?: number;
  /** Maximum holds one run may place. */
  maxHolds?: number;
}

export function planLaneAutoHold(
  streaks: LaneEmptyStreaksV1,
  targets: LaneTargetsV1,
  options: LaneAutoHoldOptions = {},
): LaneAutoHoldDecision[] {
  const minEmpties = Number.isSafeInteger(options.minEmpties) && options.minEmpties! >= 1
    ? options.minEmpties!
    : LANE_AUTOHOLD_MIN_EMPTIES;
  const maxHolds = Number.isSafeInteger(options.maxHolds) && options.maxHolds! >= 0
    ? options.maxHolds!
    : LANE_AUTOHOLD_MAX_HOLDS;
  const rows = new Map(targets.lanes.map((row) => [row.lane, row]));
  // Every streak row has >= 1 launch inside the window, so `streaks.lanes`
  // is exactly "lanes with launches in the window".
  const burning = streaks.lanes.filter((lane) => lane.verdict === 'burning').length;
  const fleetWide = burning * 2 > streaks.lanes.length;
  const candidates = streaks.lanes
    .filter((lane) => lane.verdict === 'burning' && lane.empties >= minEmpties)
    .sort((a, b) => b.empties - a.empties || a.lane.localeCompare(b.lane));
  let holds = 0;
  return candidates.map((lane) => {
    const target = rows.get(lane.lane);
    let reason: LaneAutoHoldSkipReason | null = null;
    if (fleetWide) reason = 'fleet-wide';
    else if (target === undefined) reason = 'no-target';
    else if (target.held) reason = 'already-held';
    else if (target.target === 0) reason = 'target-zero';
    else if (holds >= maxHolds) reason = 'over-cap';
    else holds += 1;
    return {
      lane: lane.lane,
      action: reason === null ? 'hold' : 'skip',
      reason,
      launches: lane.launches,
      empties: lane.empties,
    };
  });
}
