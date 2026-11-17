import { describe, expect, it } from 'vitest';
import { claudePoolMode, projectPoolBudgets, validateBudgetReading } from '../src/core/fleet/pool-budget.js';

const now = new Date('2026-11-15T05:00:00Z');
const reading = (remaining: number, resetAt = '2026-11-16T00:00:00Z') => validateBudgetReading({
  pool: 'claude', bucket: 'weeklyPct', remaining, resetAt,
  timestamp: '2026-11-14T00:00:00Z', source: 'manual',
});

describe('Claude pool mode follows observed weekly allowance', () => {
  it('holds Claude when no reading exists, independently of other pools', () => {
    const snapshot = projectPoolBudgets([], now);
    expect(snapshot.pools.claude).toMatchObject({ mode: 'held', remainingWeeklyPct: null });
    expect(snapshot.pools.claude.buckets.weeklyPct?.state).toBe('unknown');
    expect(claudePoolMode(undefined)).toBe('held');
    expect(snapshot.pools['codex-personal'].mode).toBe('metered');
    expect(snapshot.pools['local-omlx'].mode).toBe('capacity-only');
  });

  it('reports metered only with positive observed weekly allowance', () => {
    const snapshot = projectPoolBudgets([reading(40)], now);
    expect(snapshot.schema).toBe('fleet.budgets.v1');
    expect(snapshot.pools.claude).toMatchObject({ mode: 'metered', remainingWeeklyPct: 40 });
    expect(snapshot.pools.claude.buckets.weeklyPct?.state).toBe('observed');
    expect(snapshot.pools['codex-personal'].mode).toBe('metered');
    expect(snapshot.pools['local-omlx'].mode).toBe('capacity-only');
  });

  it('holds Claude when the observed allowance is exhausted', () => {
    expect(projectPoolBudgets([reading(0)], now).pools.claude).toMatchObject({
      mode: 'held', remainingWeeklyPct: 0, buckets: { weeklyPct: { state: 'observed' } },
    });
  });

  it.each(['2026-11-15T04:00:00Z', '2026-11-15T05:00:00Z'])(
    'holds Claude at or after reset %s until a new reading arrives', resetAt => {
      expect(projectPoolBudgets([reading(40, resetAt)], now).pools.claude).toMatchObject({
        mode: 'held', remainingWeeklyPct: null, buckets: { weeklyPct: { state: 'reset-pending' } },
      });
    },
  );
});
