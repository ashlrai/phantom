import { describe, expect, it } from 'vitest';
import { describeFleetRuns, fleetRunsBadge, fleetRunsTone } from './fleet-runs-badge.js';

const base = { v: 1, workers: [{ job: 'a' }], leaders: [], mergesLastHour: { count: 5 }, switches: [] };

describe('fleet runs badge — personal usage threshold', () => {
  it('keeps running tone when personalPct is 92 (below threshold)', () => {
    const badge = fleetRunsBadge({ ...base, codexPersonal: { usedPct: 92 } })!;
    expect(badge.personalPct).toBe(92);
    expect(fleetRunsTone(badge)).toBe('running');
  });

  it('switches to warning at 95%', () => {
    const badge = fleetRunsBadge({ ...base, codexPersonal: { usedPct: 95 } })!;
    expect(badge.personalPct).toBe(95);
    expect(fleetRunsTone(badge)).toBe('warning');
  });

  it('switches to warning at 100%', () => {
    const badge = fleetRunsBadge({ ...base, codexPersonal: { usedPct: 100 } })!;
    expect(badge.personalPct).toBe(100);
    expect(fleetRunsTone(badge)).toBe('warning');
  });

  it('keeps existing warning tone when personalPct is absent', () => {
    const badge = fleetRunsBadge(base)!;
    expect(badge.personalPct).toBeNull();
    expect(fleetRunsTone(badge)).toBe('running');
  });
});
