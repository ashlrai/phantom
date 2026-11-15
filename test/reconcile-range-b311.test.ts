import { describe, expect, it } from 'vitest';
import { evaluateFtPromotion, ftMergeRateDropped } from '../src/core/ft/promotion-policy.js';

const baseline = { heldOutPass: 0.4, sweLitePass: 0.6, toolValidity: 1, loopRate: 0.2, p50LatencyMs: 80 };

describe('reconcile-range-b311: fine-tuning promotion policy (PR #4246)', () => {
  it('promotes a candidate that clears every gate', () => {
    const candidate = { heldOutPass: 0.44, sweLitePass: 0.62, toolValidity: 0.99, loopRate: 0.18, p50LatencyMs: 90 };
    expect(evaluateFtPromotion(baseline, candidate)).toEqual({ eligible: true, failed: [] });
  });

  it('names each gate the candidate failed', () => {
    const candidate = { heldOutPass: 0.42, sweLitePass: 0.55, toolValidity: 0.9, loopRate: 0.25, p50LatencyMs: 200 };
    expect(evaluateFtPromotion(baseline, candidate)).toEqual({
      eligible: false,
      failed: ['held-out', 'swe-lite', 'tool-validity', 'loop-rate', 'latency'],
    });
  });

  it('rejects out-of-range or missing measurements instead of scoring them', () => {
    expect(() => evaluateFtPromotion(baseline, { ...baseline, toolValidity: 1.5 })).toThrow();
    expect(() => evaluateFtPromotion(baseline, { ...baseline, p50LatencyMs: Number.NaN })).toThrow();
  });

  it('flags a shadow merge-rate drop using exact integer math', () => {
    expect(ftMergeRateDropped({ merged: 4, total: 5 }, { merged: 7, total: 10 })).toBe(true);
    expect(ftMergeRateDropped({ merged: 1, total: 2 }, { merged: 3, total: 4 })).toBe(false);
    expect(() => ftMergeRateDropped({ merged: 0, total: 0 }, { merged: 1, total: 1 })).toThrow();
  });
});
