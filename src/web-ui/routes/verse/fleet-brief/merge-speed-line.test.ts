import { describe, expect, it } from 'vitest';
import { mergeSpeedLine } from './merge-speed-line.js';

describe('mergeSpeedLine', () => {
  it('omits unknown counts and preserves zero', () => {
    expect(mergeSpeedLine({ count: null, items: [] }, 0)).toBeNull();
    expect(mergeSpeedLine({ count: 0, items: [] }, 0)).toBe('Merges: 0 in the last hour');
    expect(mergeSpeedLine({ count: 12, items: [] }, 0)).toBe('Merges: 12 in the last hour');
  });

  it('formats the supplied rate, median and slowest merged PR', () => {
    expect(mergeSpeedLine({ count: 12, perHour: 33, medianOpenToMergeMs: 360_000, items: [
      { number: 2400, openToMergeMs: 10_000 }, { number: 2410, openToMergeMs: 2_460_000 },
      { number: 2420, openToMergeMs: 120_000 },
    ] }, 0)).toBe('Merges: 12 in the last hour · 33/h · median open→merge 6 min · slowest #2410 (41 min)');
  });

  it('omits only facts that are unavailable', () => {
    expect(mergeSpeedLine({ count: 1, perHour: 1, medianOpenToMergeMs: null, items: [{ number: 1 }, { number: 2, openToMergeMs: null }] }, 0))
      .toBe('Merges: 1 in the last hour · 1/h');
    expect(mergeSpeedLine({ count: 1, items: [{ number: 1, openToMergeMs: 1_000 }] }, 0))
      .toBe('Merges: 1 in the last hour · slowest #1 (1 s)');
  });

  it.each([
    [0, '0 s'], [59_999, '59 s'], [60_000, '1 min'], [3_599_999, '59 min'],
    [3_600_000, '1 h 0 min'], [7_260_000, '2 h 1 min'],
  ])('formats %i milliseconds as %s', (ms, expected) => {
    expect(mergeSpeedLine({ count: 1, medianOpenToMergeMs: ms, items: [] }, 0)).toBe(`Merges: 1 in the last hour · median open→merge ${expected}`);
  });

  it('rejects non-finite and negative facts independently', () => {
    expect(mergeSpeedLine({ count: NaN, items: [] }, 0)).toBeNull();
    expect(mergeSpeedLine({ count: Infinity, items: [] }, 0)).toBeNull();
    expect(mergeSpeedLine({ count: 1, perHour: NaN, medianOpenToMergeMs: Infinity, items: [
      { number: 1, openToMergeMs: NaN }, { number: 2, openToMergeMs: -1 }, { number: NaN, openToMergeMs: 10 },
    ] }, 0)).toBe('Merges: 1 in the last hour');
  });
});
