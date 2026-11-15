import { describe, expect, it } from 'vitest';
import { evaluateFtPromotion, ftMergeRateDropped } from '../src/core/ft/promotion-policy.js';

const baseline = { heldOutPass: 0.5, sweLitePass: 0.5, toolValidity: 0.99, loopRate: 0.1, p50LatencyMs: 100 };
const candidate = { ...baseline, heldOutPass: 0.53, toolValidity: 0.98, p50LatencyMs: 120 };

describe('fine-tuning promotion policy', () => {
  it('accepts the inclusive boundaries', () => {
    expect(evaluateFtPromotion(baseline, candidate)).toEqual({ eligible: true, failed: [] });
  });
  it('reports every failing threshold', () => {
    expect(evaluateFtPromotion(baseline, { heldOutPass: 0.52, sweLitePass: 0.49, toolValidity: 0.979, loopRate: 0.101, p50LatencyMs: 121 }).failed)
      .toEqual(['held-out', 'swe-lite', 'tool-validity', 'loop-rate', 'latency']);
  });
  it('refuses missing, nonfinite, and out-of-range measurements', () => {
    for (const value of [NaN, Infinity, -1, 1.01]) {
      expect(() => evaluateFtPromotion(baseline, { ...candidate, toolValidity: value })).toThrow();
    }
    expect(() => evaluateFtPromotion(baseline, { ...candidate, p50LatencyMs: 0 })).toThrow();
  });
  it('detects a merge-rate drop without rounding and refuses unknown samples', () => {
    expect(ftMergeRateDropped({ merged: 2, total: 3 }, { merged: 1, total: 2 })).toBe(true);
    expect(ftMergeRateDropped({ merged: 1, total: 2 }, { merged: 2, total: 4 })).toBe(false);
    expect(() => ftMergeRateDropped({ merged: 0, total: 0 }, { merged: 1, total: 1 })).toThrow();
  });
});
