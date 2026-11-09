import { describe, expect, it } from 'vitest';
import { projectGoals } from '../src/core/fleet/goals.js';

describe('goals', () => {
  it('projects the dispatcher cohort and keeps an unknown pool unknown', () => {
    const result = projectGoals({ last_tick: '2026-11-09T12:00:00Z', rollup_24h: { by_lane: { work: { merged: 12, median_ttm_s: 120, empty_rate: 0.25 } } }, budget: { known: { weekly_used_pct: 40, reset_at: '2026-11-10T12:00:00Z' }, unknown: { weekly_used_pct: null, reset_at: null } } });
    expect(result.lanes).toEqual([{ lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25 }]);
    expect(result.pools).toEqual([{ pool: 'known', usedPercent: 40, resetAt: '2026-11-10T12:00:00Z' }, { pool: 'unknown', usedPercent: null, resetAt: null }]);
    expect(projectGoals(null).available).toBe(false);
  });
});
