import { describe, expect, it } from 'vitest';
import { usagePace } from './usage-pace.js';

const now = Date.parse('2026-11-10T12:00:00Z');
const resetAt = '2026-11-10T22:00:00Z';
const pace = (usedFrac: number, ratePerHour: number) => usagePace({ usedFrac, ratePerHour, resetAt, now });

describe('usagePace', () => {
  it('classifies projections and includes both boundaries on pace', () => {
    expect(pace(0.5, 0.04)).toEqual({ kind: 'on-pace' });
    expect(pace(0.5, 0.05)).toEqual({ kind: 'on-pace' });
    expect(pace(0.5, 0.02)).toEqual({ kind: 'waste', wastePct: 30.000000000000004 });
    expect(pace(0.5, 0.1)).toEqual({ kind: 'runs-out', runsOutAt: now + 5 * 3_600_000 });
  });
  it('handles zero rate and missing or expired inputs', () => {
    expect(pace(0.25, 0)).toEqual({ kind: 'waste', wastePct: 75 });
    expect(usagePace({ usedFrac: 0.5, ratePerHour: null, resetAt, now })).toEqual({ kind: 'unknown' });
    expect(usagePace({ usedFrac: 0.5, ratePerHour: 0.1, resetAt, now: Date.parse(resetAt) })).toEqual({ kind: 'unknown' });
    expect(pace(0.5, -1)).toEqual({ kind: 'unknown' });
  });
});
