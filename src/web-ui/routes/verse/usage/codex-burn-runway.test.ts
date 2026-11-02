import { describe, expect, it } from 'vitest';
import { runwayHours } from './codex-burn-model.js';

describe('runwayHours', () => {
  it('computes hours remaining for a normal case', () => {
    expect(runwayHours(60, 3.4)).toBeCloseTo(11.764705882352942, 4);
  });

  it('returns null when pace is null', () => {
    expect(runwayHours(50, null)).toBeNull();
  });

  it('returns null when pace is zero', () => {
    expect(runwayHours(50, 0)).toBeNull();
  });

  it('returns null when pace is negative', () => {
    expect(runwayHours(50, -1)).toBeNull();
  });

  it('returns 0 when usage is at 100', () => {
    expect(runwayHours(100, 5)).toBe(0);
  });

  it('returns 0 when usage exceeds 100', () => {
    expect(runwayHours(120, 5)).toBe(0);
  });

  it('returns 0 when usedPct is null and pace is positive', () => {
    expect(runwayHours(null, 5)).toBe(0);
  });
});
