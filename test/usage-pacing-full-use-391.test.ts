import { describe, expect, it } from 'vitest';
import { USAGE_PACE_TARGET_PCT, usagePacing } from '../src/core/fleet/usage-pacing.js';

const now = Date.parse('2026-11-15T00:00:00Z');
const resetAt = '2026-11-15T10:00:00Z';

describe('full subscription usage pacing', () => {
  it('allows slow burn at 99% toward full usage at reset', () => {
    const result = usagePacing({ resetAt, readings: [
      { pct: 98.95, at: '2026-11-14T23:00:00Z' },
      { pct: 99, at: '2026-11-15T00:00:00Z' },
    ] }, now);

    expect(result.pointsPerHour).toBeCloseTo(0.05);
    expect(result.paceNeeded).toBeGreaterThan(0);
    expect(result.paceNeeded).toBeCloseTo(0.1);
    expect(result).toMatchObject({ throttle: false, preferMacPools: false, boxAgentTurnMultiplier: 1 });
  });

  it('throttles at actual exhaustion before reset', () => {
    expect(usagePacing({ resetAt, readings: [
      { pct: 100, at: '2026-11-15T00:00:00Z' },
    ] }, now)).toMatchObject({ throttle: true, paceNeeded: 0 });
  });

  it('does not hard throttle at 98.5% with a single reading', () => {
    expect(usagePacing({ resetAt, readings: [
      { pct: 98.5, at: '2026-11-15T00:00:00Z' },
    ] }, now)).toMatchObject({ throttle: false, pointsPerHour: null, paceNeeded: 0.15 });
  });

  it('targets 100% without a subscription reserve', () => {
    expect(USAGE_PACE_TARGET_PCT).toBe(100);
  });
});
