import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { PauseRecord } from '../fleet-lanes/lane-pause-model.js';

export interface PaletteLane {
  lane: string;
  running: number;
  target: number;
  held: boolean;
  paused: boolean;
}

export function paletteLanes(runs: FleetRuns | null | undefined, record: PauseRecord): PaletteLane[] {
  return (runs?.lanes ?? []).map(({ lane, running, target, held }) => ({
    lane, running, target, held, paused: target === 0 || record[lane] > 0,
  }));
}

export function laneItemTitle(l: PaletteLane): string {
  return `Lane ${l.lane}: ${l.running}/${l.target} running · ${l.paused ? 'paused · resume' : 'pause'}${l.held ? ' · held, resume target only' : ''}`;
}
