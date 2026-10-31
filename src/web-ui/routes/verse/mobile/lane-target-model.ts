import type { LaneTargetsV1 } from '../../../../core/fleet/runs-lane-targets.js';
import type { FleetRunsLane } from './runs-queries.js';

export interface MobileLaneRow extends FleetRunsLane {
  floor: number;
  ceiling: number;
  writable: boolean;
}

export function mergeLaneRows(runsLanes: FleetRunsLane[], targets: LaneTargetsV1 | null): MobileLaneRow[] {
  const controls = new Map(targets?.lanes.map((row) => [row.lane, row]));
  return runsLanes.map((lane) => {
    const control = controls.get(lane.lane);
    const held = control?.held ?? lane.held;
    return { ...lane, target: control?.target ?? lane.target, held,
      heldReason: control ? control.heldReason : lane.heldReason,
      floor: control?.floor ?? 0, ceiling: control?.ceiling ?? lane.target ?? 0,
      writable: targets !== null && !held };
  });
}

export function clampTarget(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, Number.isFinite(value) ? Math.trunc(value) : floor));
}

export function confirmText(lane: string, from: number, to: number) {
  return { title: `Set ${lane} target to ${to}?`,
    body: `Your Mac will ${to > from ? 'launch' : 'wind down'} workers to match the ${lane} target of ${to}.`,
    confirmLabel: 'Set target', done: `${lane} target is now ${to}.` };
}
