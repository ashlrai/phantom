import { useSyncExternalStore } from 'react';
import type { FleetEngine, FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';

export interface LaneSample { at: number; busy: number; slots: number }
export interface LaneSummary { points: number[]; first: number; last: number; spanMs: number }

export const MAX_SAMPLES = 120;
export const MIN_GAP_MS = 4_000;
const history = new Map<FleetEngine, readonly LaneSample[]>();
const listeners = new Set<() => void>();
const empty: readonly LaneSample[] = [];
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

export function recordLaneSamples(snapshot: FleetLiveSnapshotV1, nowMs = Date.now()): void {
  const timestamp = Date.parse(snapshot.generatedAt);
  const at = Number.isFinite(timestamp) ? timestamp : nowMs;
  let updated = false;
  for (const lane of snapshot.lanes) {
    const previous = history.get(lane.lane) ?? empty;
    const last = previous[previous.length - 1];
    if (last && at - last.at < MIN_GAP_MS) continue;
    history.set(lane.lane, [...previous, { at, busy: lane.busy, slots: lane.slots }].slice(-MAX_SAMPLES));
    updated = true;
  }
  if (updated) changed();
}

export function laneHistory(lane: FleetEngine): readonly LaneSample[] {
  return history.get(lane) ?? empty;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLaneHistory(lane: FleetEngine): readonly LaneSample[] {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return laneHistory(lane);
}

export function summariseLane(samples: readonly LaneSample[], _nowMs: number): LaneSummary | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return { points: samples.map((sample) => sample.busy), first: first.busy, last: last.busy, spanMs: last.at - first.at };
}

export function describeLane(label: string, summary: LaneSummary): string {
  const duration = summary.spanMs < 60_000 ? 'the last minute' : `${Math.floor(summary.spanMs / 60_000)} min`;
  return `${label}: ${summary.first} → ${summary.last} busy over ${duration}`;
}

export function resetLaneHistory(): void {
  if (history.size === 0) return;
  history.clear();
  changed();
}
