import { describe, expect, it } from 'vitest';
import { projectUsagePace } from '../src/core/usage/pace.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const lane = (projected: number) => ({ use_it_all: { known: true, stale: false, used_pct: 10, hours_to_reset: 50, burn_pct_per_hour: 1, projected_used_pct: projected } });
const status = { schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z', budget: {
  devin: lane(62), 'codex-cmp': lane(97), claude: lane(80), 'codex-personal': lane(50), '../x': lane(10), Bad: lane(10),
  'no-pace': { other: 1 },
} };

describe('usage pace across all budgeted pools', () => {
  it('lists core pools first, then other valid budgeted lanes by name', () => {
    const { pools } = projectUsagePace(status, now);
    expect(pools.map(r => r.pool)).toEqual(['zai', 'gemini', 'claude', 'codex-personal', 'codex-cmp', 'devin']);
    expect(pools.find(r => r.pool === 'devin')).toMatchObject({ projectedPercent: 62, hoursLeft: 50, unusedPercent: 38 });
    expect(pools.find(r => r.pool === 'codex-cmp')).toMatchObject({ projectedPercent: 97, unusedPercent: 3 });
    expect(pools.find(r => r.pool === 'zai')).toMatchObject({ projectedPercent: null, unusedPercent: null });
  });
  it('caps the list at 24 pools', () => {
    const budget = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`lane-${String(i).padStart(2, '0')}`, lane(50)]));
    expect(projectUsagePace({ ...status, budget }, now).pools).toHaveLength(24);
  });
  it('returns exactly the four core rows with nulls when stale or missing', () => {
    for (const snap of [projectUsagePace(status, now + 120_001), projectUsagePace(null, now)]) {
      expect(snap.pools.map(r => r.pool)).toEqual(['zai', 'gemini', 'claude', 'codex-personal']);
      expect(snap.pools.every(r => r.projectedPercent === null && r.unusedPercent === null)).toBe(true);
    }
  });
});
