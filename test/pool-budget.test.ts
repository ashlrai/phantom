import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUDGET_POOLS, parseBudgetOutput, projectPoolBudgets, validateBudgetReading, type BudgetReading } from '../src/core/fleet/pool-budget.js';
const at = (hour: number) => `2026-10-25T${String(hour).padStart(2, '0')}:00:00.000Z`;
const reading = (remaining: number, hour: number, extra: Partial<BudgetReading> = {}): BudgetReading => ({ pool: 'codex-cmp', bucket: 'weeklyPct', remaining, timestamp: at(hour), resetAt: '2026-11-01T12:00:00.000Z', source: 'log', ...extra });
const view = (rows: BudgetReading[], hour = 11) => projectPoolBudgets(rows, new Date(at(hour))).pools['codex-cmp'].buckets.weeklyPct!;
describe('per-pool budgets', () => {
  it('keeps CMP weekly exhaustion, reset, and credits independent', () => {
    const rows = JSON.parse(readFileSync(new URL('./fixtures/pool-budget/cmp-reset.json', import.meta.url), 'utf8')).map(validateBudgetReading);
    const exhausted = projectPoolBudgets(rows, new Date(at(11))).pools['codex-cmp'];
    expect(exhausted.remainingWeeklyPct).toBe(0);
    expect(exhausted.remainingCredits).toBe(42);
    expect(exhausted.buckets.weeklyPct?.burnPerHour.last2).toBe(10);
    expect(view(rows, 12)).toMatchObject({ remaining: null, state: 'reset-pending' });
    const reset = projectPoolBudgets(rows, new Date(at(13))).pools['codex-cmp'];
    expect(reset.remainingWeeklyPct).toBe(100);
    expect(reset.remainingCredits).toBe(42);
    expect(reset.buckets.weeklyPct?.burnPerHour.last2).toBeNull();
  });
  it('shows all pools with unknown balances, held Claude, and capacity-only local', () => {
    const snapshot = projectPoolBudgets([]);
    expect(Object.keys(snapshot.pools)).toEqual(BUDGET_POOLS);
    expect(snapshot.pools.claude.mode).toBe('held');
    expect(snapshot.pools['local-omlx'].mode).toBe('capacity-only');
    expect(snapshot.pools.devin.buckets.acus?.remaining).toBeNull();
  });
  it('computes last-two and twelve-hour rates and exhaustion from observation time', () => {
    expect(view([reading(90, 1), reading(50, 9), reading(30, 11)])).toMatchObject({
      burnPerHour: { last2: 10, last12h: 6 }, projectedExhaustion: at(14),
    });
  });
  it('limits twelve-hour burn to observations inside the window', () => {
    expect(view([reading(90, 1), reading(50, 14)], 15).burnPerHour).toEqual({ last2: 40 / 13, last12h: null });
  });
  it('resolves simultaneous conflicting readings deterministically and conservatively', () => {
    const rows = [reading(20, 9), reading(10, 9)];
    expect(view(rows).remaining).toBe(10);
    expect(view([...rows].reverse())).toEqual(view(rows));
  });
  it('does not extrapolate beyond reset or interpret refills as burn', () => {
    expect(view([reading(90, 9), reading(100, 10)]).burnPerHour.last2).toBeNull();
    const rows = [reading(90, 9), reading(80, 10)].map(r => ({ ...r, resetAt: at(12) }));
    expect(view(rows).projectedExhaustion).toBeNull();
  });
  it('manual readings override later auto readings until reset, independently per bucket', () => {
    const rows = [reading(25, 9, { source: 'manual', resetAt: at(12) }), reading(10, 10), reading(100, 13)];
    expect(view(rows)).toMatchObject({ remaining: 25, source: 'manual' });
    expect(view(rows, 14)).toMatchObject({ remaining: 100, source: 'log' });
  });
  it('manual with no reset persists, including out-of-order imports', () => {
    expect(view([reading(5, 10), reading(30, 9, { source: 'manual', resetAt: null })])).toMatchObject({ remaining: 30, source: 'manual' });
  });
  it('manual wins equal timestamp; duplicate samples do not divide by zero', () => {
    expect(view([reading(30, 9, { source: 'manual' }), reading(5, 9)])).toMatchObject({ remaining: 30, burnPerHour: { last2: null } });
  });
  it('does not calculate spend burn for capacity', () => {
    const rows = [reading(8, 9), reading(2, 10)].map(r => ({ ...r, pool: 'local-omlx' as const, bucket: 'capacity' as const }));
    expect(projectPoolBudgets(rows, new Date(at(11))).pools['local-omlx'].buckets.capacity).toMatchObject({ remaining: 2, burnPerHour: { last2: null, last12h: null }, projectedExhaustion: null });
  });
  it.each([-1, 101, NaN, Infinity])('rejects invalid weekly value %s', remaining => {
    expect(() => validateBudgetReading(reading(remaining, 9))).toThrow();
  });
  it('rejects invalid times, bucket mismatches and sources', () => {
    for (const patch of [{ timestamp: '2026-02-30T00:00:00Z' }, { resetAt: at(8) }, { bucket: 'acus' }, { source: 'untrusted' }, { pool: '__proto__' }]) {
      expect(() => validateBudgetReading({ ...reading(5, 9), ...patch })).toThrow();
    }
  });
  it('parses labelled status and rate-limit lines without retaining unrelated text', () => {
    const parsed = parseBudgetOutput('codex-cmp', 'cli', 'weekly remaining: 25% reset: 2026-11-01T12:00:00Z\ncredits remaining: 42\nprivate-token=discard\nrate-limit weekly used: 90%', at(9));
    expect(parsed.map(r => r.remaining)).toEqual([25, 42, 10]);
    expect(JSON.stringify(parsed)).not.toContain('private-token');
    expect(parseBudgetOutput('devin', 'log', 'acus remaining: 12.5', at(9))[0]?.remaining).toBe(12.5);
  });
  it('parses native Codex quota logs with their original time, ignoring five-hour allowance and transcript', () => {
    const output = readFileSync(new URL('./fixtures/pool-budget/codex.jsonl', import.meta.url), 'utf8');
    const parsed = parseBudgetOutput('codex-cmp', 'log', output, at(11));
    expect(parsed.map(r => [r.bucket, r.remaining, r.timestamp])).toEqual([['weeklyPct', 0, at(10)], ['credits', 42.5, at(10)]]);
    expect(JSON.stringify(parsed)).not.toContain('transcript');
  });
  it('ignores ambiguous output and rejects oversized input', () => {
    expect(parseBudgetOutput('codex-cmp', 'log', '429 too many requests\ncredits used: 5\ncredits remaining: 5%', at(9))).toEqual([]);
    expect(() => parseBudgetOutput('codex-cmp', 'log', 'x'.repeat(1_048_577), at(9))).toThrow();
  });
});
