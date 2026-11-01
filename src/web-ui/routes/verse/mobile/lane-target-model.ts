import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
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
  return { paused, label: paused ? pauseLabel(row.lane, record, row.pausedFrom) : null,
    resumeTarget: resumeTransition(row.lane, record, row.floor, row.pausedFrom).target };
}

export interface MobileLaneRow extends FleetRunsLane {
  floor: number;
  ceiling: number;
  writable: boolean;
  pausedFrom: number | null;
  /** When the hold expires; only the control read carries it. */
  heldUntil?: string | null;
  /** Who placed the hold (unheld/held/changed attribution, latest wins). */
  changedBy?: string | null;
}

export function mergeLaneRows(runsLanes: FleetRunsLane[], targets: LaneTargetsV1 | null): MobileLaneRow[] {
  const controls = new Map(targets?.lanes.map((row) => [row.lane, row]));
  return runsLanes.map((lane) => {
    const control = controls.get(lane.lane);
    const held = control?.held ?? lane.held;
    return { ...lane, target: control?.target ?? lane.target, held,
      heldReason: control ? control.heldReason : lane.heldReason,
      heldUntil: control?.heldUntil ?? null,
      changedBy: control?.changedBy ?? null,
      floor: control?.floor ?? 0, ceiling: control?.ceiling ?? lane.target ?? 0,
      pausedFrom: control?.pausedFrom ?? null,
      writable: targets !== null && !held };
  });
}

/** Software may lift only the fleet's own hold — the same held_by 'autobackoff' rule the server enforces. */
export function holdReleasable(row: MobileLaneRow): boolean {
  return row.held === true && typeof row.changedBy === 'string' && row.changedBy.startsWith('autobackoff');
}

/** "in 40 m" for a hold's expiry — 'soon' once it passes, null when unparseable. */
export function holdClearsIn(heldUntil: string, nowMs: number): string | null {
  const time = Date.parse(heldUntil);
  if (!Number.isFinite(time)) return null;
  const ms = time - nowMs;
  if (ms <= 60_000) return 'soon';
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)} h`;
  return `in ${Math.round(ms / 86_400_000)} d`;
}

export function clampTarget(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, Number.isFinite(value) ? Math.trunc(value) : floor));
}

export function confirmText(lane: string, from: number, to: number) {
  return { title: `Set ${lane} target to ${to}?`,
    body: `Your Mac will ${to > from ? 'launch' : 'wind down'} workers to match the ${lane} target of ${to}.`,
    confirmLabel: 'Set target', done: `${lane} target is now ${to}.` };
}
