import { expect, it } from 'vitest';
import { projectUsageSpend } from '../src/core/usage/spend.js';

it('recovered spend-down: projects unused percent at reset and marks unknown pools', () => {
  const now = Date.parse('2026-11-10T20:00:00Z');
  const snapshot = projectUsageSpend({
    schema: 'dispatchd.status.v1', last_tick: '2026-11-10T19:59:50Z',
    budget: {
      'codex-personal': { use_it_all: { known: true, stale: false, used_pct: 40, reset_at: '2026-11-11T08:00:00Z', burn_pct_per_hour: 5 } },
      devin: { use_it_all: { known: true, stale: true } },
    },
  }, now);
  expect(snapshot.asOf).toBe('2026-11-10T19:59:50.000Z');
  const codex = snapshot.pools.find(row => row.pool === 'codex-personal');
  expect(codex?.projectedUnusedPercent).toBe(0); // 40 + 5*12 = 100, clamped at 0
  expect(codex?.hoursLeft).toBe(12);
  expect(snapshot.pools.find(row => row.pool === 'devin')?.reason).toBe('reading stale');
  expect(snapshot.pools.find(row => row.pool === 'gemini')?.reason).toBe('reading missing');
});
