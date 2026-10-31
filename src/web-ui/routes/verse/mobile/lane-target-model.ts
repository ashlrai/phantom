import type { LaneTargetsV1 } from '../../../../core/fleet/runs-lane-targets.js';
import type { FleetRunsLane } from './runs-queries.js';
import { LANE_PAUSE_KEY, parsePauseRecord, pauseLabel, resumeTransition, type PauseRecord } from '../fleet-lanes/lane-pause-model.js';

export function readPauseRecord(): PauseRecord {
  try { return parsePauseRecord(window.localStorage.getItem(LANE_PAUSE_KEY)); }
  catch { return {}; }
}

export function writePauseRecord(record: PauseRecord): void {
  try { window.localStorage.setItem(LANE_PAUSE_KEY, JSON.stringify(record)); }
  catch { /* Storage may be unavailable on this device. */ }
}

export function pauseState(row: MobileLaneRow, record: PauseRecord): { paused: boolean; label: string | null; resumeTarget: number } {
  const paused = row.target === 0;
  return { paused, label: paused ? pauseLabel(row.lane, record) : null,
    resumeTarget: resumeTransition(row.lane, record, row.floor).target };
}

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
