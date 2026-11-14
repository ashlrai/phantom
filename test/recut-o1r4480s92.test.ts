import { expect, it } from 'vitest';
import { projectUsageSpend } from '../src/core/usage/spend.js';

it('projects unused capacity from a fresh measured reading', () => {
  const now = Date.parse('2026-11-09T16:00:00Z');
  const result = projectUsageSpend({
    schema: 'dispatchd.status.v1', last_tick: '2026-11-09T16:00:00Z',
    budget: { 'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 20, reset_at: '2026-11-10T02:00:00Z', burn_pct_per_hour: 3 } } },
  }, now);
  expect(result.pools.find(row => row.pool === 'codex-personal')?.projectedUnusedPercent).toBe(50);
});
