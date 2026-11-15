import { describe, expect, it } from 'vitest';
import { projectUsageSpend } from '../src/core/usage/spend.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const fixture = { schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z', budget: {
  'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 20, reset_at: '2026-11-10T02:00:00Z', burn_pct_per_hour: 3 } },
  claude: { use_it_all: { known: true, stale: true } },
  custom: {},
} };
describe('spend down', () => {
  it('projects fresh measured burn and identifies stale and missing pools', () => {
    const rows = projectUsageSpend(fixture, now).pools;
    expect(rows.find(r => r.pool === 'codex-personal')).toEqual({ pool: 'codex-personal', reason: null, usedPercent: 20, resetAt: '2026-11-10T02:00:00.000Z', hoursLeft: 10, burnPerHour: 3, projectedUnusedPercent: 50 });
    expect(rows.find(r => r.pool === 'claude')?.reason).toBe('reading stale');
    expect(rows.find(r => r.pool === 'custom')?.reason).toBe('reading missing');
    expect(rows.find(r => r.pool === 'zai')?.reason).toBe('reading missing');
  });
  it('expires the whole status and rejects incomplete readings', () => {
    expect(projectUsageSpend(fixture, now + 120_001).pools.every(r => r.reason === 'status missing or stale')).toBe(true);
    expect(projectUsageSpend(null, now).pools.every(r => r.usedPercent === null)).toBe(true);
    expect(projectUsageSpend({ ...fixture, budget: { claude: { use_it_all: { known: true, stale: false } } } }, now).pools.find(r => r.pool === 'claude')?.reason).toBe('reading incomplete or reset passed');
  });
});
