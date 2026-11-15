import { describe, expect, it } from 'vitest';
import {
  laneMedians, overrunOf,
  OVERRUN_DEFAULT_WINDOW, OVERRUN_MIN_SAMPLES, OVERRUN_DEFAULT_RATIO, OVERRUN_DEFAULT_FLOOR_MS,
  type FinishedJobDuration,
} from '../src/core/fleet/job-overrun.js';

const MIN = 60_000;
const finished = (lane: string | null | undefined, durationMs: number | null | undefined): FinishedJobDuration => ({ lane, durationMs });
const durations = (lane: string, list: number[]): FinishedJobDuration[] => list.map(durationMs => finished(lane, durationMs));

describe('laneMedians', () => {
  it('reports the median duration per lane', () => {
    const medians = laneMedians([
      ...durations('devin', [10 * MIN, 30 * MIN, 20 * MIN, 50 * MIN, 40 * MIN]),
      ...durations('claude', [5 * MIN, 15 * MIN, 25 * MIN, 35 * MIN, 45 * MIN, 55 * MIN]),
    ]);
    expect(medians.get('devin')).toBe(30 * MIN);
    // Even sample count: mean of the two middle durations.
    expect(medians.get('claude')).toBe(30 * MIN);
  });

  it('keeps only the newest `window` durations per lane', () => {
    // Newest-first input: the eight newest are 1..8, the older 100 and 200 fall
    // outside window 8 and must not shift the median.
    const rows = durations('devin', [1, 2, 3, 4, 5, 6, 7, 8, 100, 200]);
    expect(laneMedians(rows, { window: 8, minSamples: 5 }).get('devin')).toBe(4.5);
    // The same rows uncapped include the stale 100/200 and median at (5+6)/2.
    expect(laneMedians(rows, { minSamples: 5 }).get('devin')).toBe(5.5);
  });

  it('caps every lane independently', () => {
    const rows = [...durations('busy', Array.from({ length: OVERRUN_DEFAULT_WINDOW + 10 }, () => 10)),
      ...durations('quiet', Array.from({ length: OVERRUN_MIN_SAMPLES }, () => 30))];
    const medians = laneMedians(rows);
    expect(medians.get('busy')).toBe(10);
    expect(medians.get('quiet')).toBe(30);
  });

  it('omits lanes with fewer than five valid samples', () => {
    const medians = laneMedians([...durations('devin', [1, 2, 3, 4]), ...durations('claude', [1, 2, 3, 4, 5])]);
    expect(medians.has('devin')).toBe(false);
    expect(medians.get('claude')).toBe(3);
  });

  it('ignores NaN, negative, zero and missing durations and missing lanes', () => {
    const medians = laneMedians([
      ...durations('devin', [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]),
      finished('devin', null), finished('devin', undefined), finished(null, 10), finished(undefined, 10),
      ...durations('devin', [10, 20, 30, 40, 50]),
    ]);
    expect(medians.get('devin')).toBe(30);
    expect(medians.size).toBe(1);
  });

  it('honors a custom minSamples', () => {
    const medians = laneMedians(durations('devin', [10, 20, 30]), { minSamples: 3 });
    expect(medians.get('devin')).toBe(20);
  });
});

describe('overrunOf', () => {
  const medians = new Map([['devin', 40 * MIN]]);
  const NOW = Date.parse('2026-11-10T12:00:00Z');

  it('flags a job running over 2x its lane median and over 20 minutes', () => {
    expect(overrunOf({ lane: 'devin', ageSeconds: 100 * 60 }, medians, NOW))
      .toEqual({ ratio: 2.5, medianMs: 40 * MIN });
  });

  it('returns null just under the ratio threshold and under the floor', () => {
    // Exactly 2x is not "over 2x".
    expect(overrunOf({ lane: 'devin', elapsedMs: 80 * MIN }, medians, NOW)).toBeNull();
    // Over 2x but at or under the 20 minute floor is not an overrun.
    expect(overrunOf({ lane: 'devin', elapsedMs: 20 * MIN }, new Map([['devin', 5 * MIN]]), NOW)).toBeNull();
    expect(overrunOf({ lane: 'devin', elapsedMs: 21 * MIN }, new Map([['devin', 10 * MIN]]), NOW)).not.toBeNull();
  });

  it('returns null when the lane has no median', () => {
    expect(overrunOf({ lane: 'zai', elapsedMs: 5 * 60 * MIN }, medians, NOW)).toBeNull();
    expect(overrunOf({ lane: 'devin', elapsedMs: 5 * 60 * MIN }, new Map(), NOW)).toBeNull();
    expect(overrunOf({ lane: 'devin', elapsedMs: 5 * 60 * MIN }, new Map([['devin', 0]]), NOW)).toBeNull();
  });

  it('returns null without a lane or a measurable elapsed', () => {
    expect(overrunOf({ lane: null, elapsedMs: 5 * 60 * MIN }, medians, NOW)).toBeNull();
    expect(overrunOf({}, medians, NOW)).toBeNull();
    expect(overrunOf({ lane: 'devin', ageSeconds: null, startedAt: 'not-a-date' }, medians, NOW)).toBeNull();
  });

  it('measures elapsed from elapsedMs, then ageSeconds, then startedAt', () => {
    expect(overrunOf({ lane: 'devin', elapsedMs: 100 * MIN, ageSeconds: 10, startedAt: NOW }, medians, NOW)).not.toBeNull();
    expect(overrunOf({ lane: 'devin', ageSeconds: 100 * 60 }, medians, NOW)).not.toBeNull();
    expect(overrunOf({ lane: 'devin', startedAt: '2026-11-10T10:00:00Z' }, medians, NOW))
      .toEqual({ ratio: 3, medianMs: 40 * MIN });
    expect(overrunOf({ lane: 'devin', startedAt: NOW - 100 * MIN }, medians, NOW)).not.toBeNull();
  });

  it('honors custom ratio and floor thresholds', () => {
    const job = { lane: 'devin', elapsedMs: 30 * MIN };
    expect(overrunOf(job, medians, NOW)).toBeNull();
    expect(overrunOf(job, medians, NOW, { ratio: 0.5 })).toEqual({ ratio: 0.75, medianMs: 40 * MIN });
    expect(overrunOf({ lane: 'devin', elapsedMs: 25 * MIN }, new Map([['devin', 10 * MIN]]), NOW, { floorMs: 30 * MIN })).toBeNull();
    expect(overrunOf({ lane: 'devin', elapsedMs: 25 * MIN }, new Map([['devin', 10 * MIN]]), NOW, { floorMs: 24 * MIN })).not.toBeNull();
  });

  it('exposes the shipped defaults the spec pins', () => {
    expect(OVERRUN_DEFAULT_WINDOW).toBe(200);
    expect(OVERRUN_MIN_SAMPLES).toBe(5);
    expect(OVERRUN_DEFAULT_RATIO).toBe(2);
    expect(OVERRUN_DEFAULT_FLOOR_MS).toBe(20 * 60_000);
  });
});
