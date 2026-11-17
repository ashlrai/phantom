/** Status colour on the compute map follows a reading, and a missing reading never looks healthy. */
import { describe, expect, it } from 'vitest';
import { heatBand, laneQuotaState } from './ComputeMap.js';

describe('lane quota edge', () => {
  it('is green only for a confirmed quota and never for a missing reading', () => {
    expect(laneQuotaState(false, true)).toBe('ok');
    expect(laneQuotaState(undefined, undefined)).toBe('unknown');
    expect(laneQuotaState(null, null)).toBe('unknown');
    expect(laneQuotaState(false, false)).toBe('blocked');
  });

  it('lets a hold outrank the quota reading', () => {
    expect(laneQuotaState(true, true)).toBe('held');
    expect(laneQuotaState(true, false)).toBe('held');
  });
});

describe('machine heat', () => {
  it('uses one set of bands for the card edge and the meter', () => {
    expect(heatBand(0.2)).toBe('cool');
    expect(heatBand(0.7)).toBe('warm');
    expect(heatBand(0.99)).toBe('warm');
    expect(heatBand(1)).toBe('hot');
    expect(heatBand(2.21)).toBe('hot');
  });
});
