import { describe, expect, it } from 'vitest';
import { projectBurnExhaustion } from '../src/core/fabric/burn-projection.js';

describe('projectBurnExhaustion', () => {
  it('returns null for flat, declining, single-point and duplicate-time series', () => {
    expect(projectBurnExhaustion([{ timestampMs: 0, pctUsed: 20 }, { timestampMs: 10, pctUsed: 20 }])).toBeNull();
    expect(projectBurnExhaustion([{ timestampMs: 0, pctUsed: 20 }, { timestampMs: 10, pctUsed: 10 }])).toBeNull();
    expect(projectBurnExhaustion([{ timestampMs: 0, pctUsed: 20 }])).toBeNull();
    expect(projectBurnExhaustion([{ timestampMs: 0, pctUsed: 20 }, { timestampMs: 0, pctUsed: 30 }])).toBeNull();
  });

  it('projects a steep burn from unsorted readings without mutating them', () => {
    const readings = [{ timestampMs: 1_700_000_001_000, pctUsed: 50 }, { timestampMs: 1_700_000_000_000, pctUsed: 10 }];
    const copy = structuredClone(readings);
    expect(projectBurnExhaustion(readings)).toEqual({ ratePerMs: 0.04, exhaustionTimeMs: 1_700_000_002_250, readingsUsed: 2 });
    expect(readings).toEqual(copy);
  });

  it('fits noisy readings while rejecting an isolated outlier', () => {
    const readings = [10, 20.2, 29.8, 90, 50.1, 60].map((pctUsed, timestampMs) => ({ timestampMs, pctUsed }));
    const result = projectBurnExhaustion(readings);
    expect(result?.readingsUsed).toBe(5);
    expect(result?.ratePerMs).toBeCloseTo(10, 0);
    expect(result?.exhaustionTimeMs).toBeCloseTo(9, 1);
  });

  it('ignores invalid readings and reports an already exhausted fit in the past', () => {
    const result = projectBurnExhaustion([
      { timestampMs: 0, pctUsed: 90 }, { timestampMs: 10, pctUsed: 100 },
      { timestampMs: NaN, pctUsed: 50 }, { timestampMs: 20, pctUsed: 101 },
    ]);
    expect(result?.exhaustionTimeMs).toBe(10);
    expect(result?.readingsUsed).toBe(2);
  });
});
