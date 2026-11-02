import { describe, expect, it } from 'vitest';
import { ageStateText, laneAgeThresholds, workerAgeState } from './worker-age-state.js';

describe('worker age state', () => {
  it.each([
    ['devin', 90, 180], ['codex-local', 60, 120], ['codex-personal', 30, 60],
    ['codex-cmp', 30, 60], ['claude', 30, 60], ['claude-api', 30, 60], ['unknown', 30, 60],
  ])('uses lane thresholds and strict boundaries for %s', (lane, long, stuck) => {
    expect(laneAgeThresholds(lane)).toEqual({ longSec: long * 60, stuckSec: stuck * 60 });
    expect(workerAgeState(lane, null)).toBe('normal');
    expect(workerAgeState(lane, long * 60)).toBe('normal');
    expect(workerAgeState(lane, long * 60 + 1)).toBe('long');
    expect(workerAgeState(lane, stuck * 60)).toBe('long');
    expect(workerAgeState(lane, stuck * 60 + 1)).toBe('stuck');
    expect(ageStateText('normal', lane)).toBeNull();
    expect(ageStateText('long', lane)).toBe(`Long for this lane (over ${long} min)`);
    expect(ageStateText('stuck', lane)).toBe(`Likely stuck (over ${stuck} min); open its log`);
  });
});
