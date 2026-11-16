import type { LaneTargetRow } from './lane-targets-model.js';

export interface LaneBacklogHint { line: string | null; raiseTo: number | null }

/**
 * Running/waiting readout for a lane target row, plus a one-click raise
 * suggestion when the backlog is at least three times the current target.
 * Unknown runs stay unknown: no line, never a made-up zero.
 */
export function laneBacklogHint(target: LaneTargetRow, runs: { running: number; queued: number } | null): LaneBacklogHint {
  if (!runs) return { line: null, raiseTo: null };
  const line = `running ${runs.running} of ${target.target}${runs.queued > 0 ? ` · ${runs.queued} waiting` : ''}`;
  const starved = !target.held && target.target < target.ceiling && runs.queued >= 3 * Math.max(1, target.target);
  const raiseTo = starved ? Math.min(target.ceiling, target.target + Math.ceil(runs.queued / 3)) : null;
  return { line, raiseTo: raiseTo !== null && raiseTo > target.target ? raiseTo : null };
}
