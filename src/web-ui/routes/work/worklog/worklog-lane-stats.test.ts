import { describe, expect, it } from 'vitest';
import type { WorklogEntry } from '../../../../core/fleet/worklog.js';
import { formatDuration, laneStats } from './worklog-lane-stats.js';

const entry = (lane: string | null, seconds: number | null, model: string | null = null): WorklogEntry => ({
  job: null, repo: null, lane, model, mergedAt: '', openToMergeSeconds: seconds, url: null,
});

describe('laneStats', () => {
  it('sorts lanes by count then name, finds odd and even medians, and counts unknown timing', () => {
    expect(laneStats([
      entry('z', 9, 'b'), entry('z', 1, 'a'), entry('z', 5, 'a'),
      entry('a', 10), entry('a', 20), entry(null, null), entry(null, null),
    ])).toEqual([
      { lane: 'z', count: 3, medianSeconds: 5, unknownTiming: 0, topModel: 'a' },
      { lane: 'a', count: 2, medianSeconds: 15, unknownTiming: 0, topModel: null },
      { lane: 'unknown', count: 2, medianSeconds: null, unknownTiming: 2, topModel: null },
    ]);
  });
});

describe('formatDuration', () => {
  it.each([[0, '0 min'], [59, '0 min'], [60, '1 min'], [3600, '1 h 0 min'], [4320, '1 h 12 min'], [null, 'unknown']])('formats %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
