import type { RunsHistory, RunsSampleLane } from './runs-history.js';

/** Consecutive observations farther apart cannot establish an observed idle interval. */
export const RUNS_STALL_MAX_SAMPLE_GAP_MS = 150_000;

export interface RunsStallWindow {
  lane: string;
  from: string;
  to: string;
  durationMs: number;
  sampleCount: number;
}

export interface RunsStallWindows {
  /** History quality; dropped records may have occurred between valid observations. */
  sourceState: RunsHistory['sourceState'];
  dropped: number;
  maxSampleGapMs: number;
  /** Observed idle intervals, not proof of dispatch failure or provider availability. */
  intervals: RunsStallWindow[];
}

/** Project only consecutive, unambiguous samples inside the supplied history window. */
export function projectRunsStallWindows(history: RunsHistory): RunsStallWindows {
  const result: RunsStallWindows = {
    sourceState: history.sourceState, dropped: history.dropped,
    maxSampleGapMs: RUNS_STALL_MAX_SAMPLE_GAP_MS, intervals: [],
  };
  // The reader does not expose where dropped lines occurred, so none can be
  // bridged safely, even when the remaining timestamps are close together.
  if (history.dropped > 0 || history.sourceState === 'missing') return result;

  const active = new Map<string, RunsStallWindow>();
  const finish = (lane: string) => {
    const window = active.get(lane);
    if (window && window.sampleCount >= 2) result.intervals.push(window);
    active.delete(lane);
  };
  for (const sample of history.samples) {
    const lanes = new Map<string, RunsSampleLane | null>();
    for (const lane of sample.lanes) {
      // Duplicate lane identifiers are ambiguous, even if both appear idle.
      lanes.set(lane.lane, lanes.has(lane.lane) ? null : lane);
    }
    for (const lane of active.keys()) {
      const value = lanes.get(lane);
      if (sample.paused !== false || !value || value.held !== false ||
          value.queued <= 0 || value.running !== 0 || value.target <= 0) finish(lane);
    }
    for (const [lane, value] of lanes) {
      if (sample.paused !== false || !value || value.held !== false ||
          value.queued <= 0 || value.running !== 0 || value.target <= 0) continue;
      const current = active.get(lane);
      if (current) {
        const gap = Date.parse(sample.at) - Date.parse(current.to);
        if (gap > 0 && gap <= RUNS_STALL_MAX_SAMPLE_GAP_MS) {
          current.to = sample.at;
          current.durationMs = Date.parse(sample.at) - Date.parse(current.from);
          current.sampleCount++;
          continue;
        }
        finish(lane);
      }
      active.set(lane, { lane, from: sample.at, to: sample.at, durationMs: 0, sampleCount: 1 });
    }
  }
  for (const lane of active.keys()) finish(lane);
  return result;
}
