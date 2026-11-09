import { describe, expect, it } from 'vitest';
import { projectUsagePace } from '../src/core/usage/pace.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const fixture = { schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z', budget: {
  'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 17, hours_to_reset: 123.6, projected_used_pct: 64 } },
  claude: { use_it_all: { known: true, stale: true, hours_to_reset: 10, projected_used_pct: 80 } },
} };
describe('usage pace', () => {
  it('reports only fresh known forecasts and leaves stale and missing pools unknown', () => {
    const { pools } = projectUsagePace(fixture, now);
    expect(pools.find(row => row.pool === 'codex-personal')).toEqual({ pool: 'codex-personal', projectedPercent: 64, hoursLeft: 123.6 });
    expect(pools.find(row => row.pool === 'claude')?.projectedPercent).toBeNull();
    expect(pools.find(row => row.pool === 'zai')?.projectedPercent).toBeNull();
  });
  it('expires a whole status and rejects malformed evidence', () => {
    expect(projectUsagePace(fixture, now + 120_001).pools.every(row => row.projectedPercent === null)).toBe(true);
    expect(projectUsagePace(null, now).pools.every(row => row.hoursLeft === null)).toBe(true);
  });
});
