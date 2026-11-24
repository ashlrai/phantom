import { describe, expect, it } from 'vitest';
import { projectUsageSpend } from '../src/core/usage/spend.js';

const now = Date.parse('2026-11-09T16:00:00Z');
const fixture = { schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z', budget: {
  'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 20, reset_at: '2026-11-10T02:00:00Z', burn_pct_per_hour: 3 } },
  claude: { use_it_all: { known: true, stale: true } },
  custom: {},
} };
describe('spend down', () => {
  it('always includes one row for every desktop pool, including an unmeasured gift', () => {
    const rows = projectUsageSpend(null, now).pools;
    const required = ['codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'zai', 'local'];
    for (const pool of required) expect(rows.filter(row => row.pool === pool)).toHaveLength(1);
    expect(new Set(rows.map(row => row.pool)).size).toBe(rows.length);
    expect(rows.find(row => row.pool === 'claude-api')?.unit).toBe('usd');
    for (const row of rows) expect(row).toMatchObject({ verdict: 'unknown', usedPercent: null,
      resetAt: null, burnPerHour: null, projectedUnusedPercent: null, projectedUnusedUsd: null });
  });

  it('keeps CMP and gift units separate and exposes their measured forecasts', () => {
    const snapshot = { ...fixture, budget: {
      'codex-cmp': { use_it_all: { known: true, stale: false, used_pct: 40,
        reset_at: '2026-11-10T02:00:00Z', burn_pct_per_hour: 6 } },
      'claude-api': { gift: { usd_remaining: 90, usd_granted: 120, as_of: fixture.last_tick,
        expires_at: '2026-11-10T02:00:00Z', usd_burn_per_hour: 3 } },
    } };
    const rows = projectUsageSpend(snapshot, now).pools;
    expect(rows.find(row => row.pool === 'codex-cmp')).toMatchObject({ unit: 'percent', usedPercent: 40,
      resetAt: '2026-11-10T02:00:00.000Z', burnPerHour: 6, projectedUnusedPercent: 0, verdict: 'on-pace' });
    expect(rows.find(row => row.pool === 'claude-api')).toMatchObject({ unit: 'usd', usedPercent: 25,
      resetAt: '2026-11-10T02:00:00.000Z', burnPerHour: 3, projectedUnusedPercent: 50,
      projectedUnusedUsd: 60, verdict: 'behind' });
    for (const row of projectUsageSpend(snapshot, now + 120_001).pools) {
      expect(row).toMatchObject({ verdict: 'unknown', usedPercent: null, resetAt: null,
        burnPerHour: null, projectedUnusedPercent: null, projectedUnusedUsd: null });
    }
  });

  it('projects fresh measured burn and identifies stale and missing pools', () => {
    const rows = projectUsageSpend(fixture, now).pools;
    expect(rows.find(r => r.pool === 'codex-personal')).toEqual({ pool: 'codex-personal', reason: null, usedPercent: 20, resetAt: '2026-11-10T02:00:00.000Z', hoursLeft: 10, burnPerHour: 3, projectedUnusedPercent: 50,
      unit: 'percent', projectedUsedPercent: 50, remainingUsd: null, projectedUnusedUsd: null, verdict: 'behind', status: 'behind', summary: 'behind: 50% would go unused', resetsIn: '10h 0m' });
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
