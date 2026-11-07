import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANE_BACKENDS, rankLanes, type LaneResourceSnapshot } from '../src/core/fleet/lane-rank.js';
import { projectPoolBudgets, type BudgetPool } from '../src/core/fleet/pool-budget.js';
import { cmdRouter } from '../src/cli/router.js';
import { readFile, stat } from 'node:fs/promises';
import { readPoolBudgets } from '../src/core/fleet/pool-budget-store.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock('../src/core/fleet/pool-budget-store.js', () => ({ readPoolBudgets: vi.fn() }));
const now = '2026-10-30T12:00:00.000Z';
const soon = '2026-10-30T13:00:00.000Z';
const later = '2026-10-31T12:00:00.000Z';
const slots = { 'codex-cmp': 2, 'codex-personal': 1 };
function snapshot(resets: (string | null)[] = [later, soon]): LaneResourceSnapshot {
  const pools: BudgetPool[] = ['codex-cmp', 'codex-personal'];
  return { budgets: projectPoolBudgets(pools.map((pool, i) => ({ pool, bucket: 'weeklyPct', remaining: 50,
    resetAt: resets[i]!, timestamp: now, source: 'cli' })), new Date(now)),
  routes: Object.fromEntries(pools.map(pool => [pool, { backend: LANE_BACKENDS[pool], tier: 'frontier', reason: 'test' }])) };
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe('lane ranking', () => {
  it('spends nearest reset first without mutating either input', () => {
    const input = snapshot(); const before = structuredClone(input);
    expect(rankLanes('frontier', input, Object.freeze(slots)).map(l => l.pool)).toEqual(['codex-personal', 'codex-cmp']);
    expect(input).toEqual(before);
  });
  it.each([[null, soon], [later, later], [null, null]])('orders unknown resets last and ties deterministically: %s / %s', (a, b) => {
    expect(rankLanes('frontier', snapshot([a, b]), slots)[0]?.pool).toBe(a === null && b !== null ? 'codex-personal' : 'codex-cmp');
  });
  it.each([0, -1, NaN, Infinity, 1.5, null, undefined])('excludes unavailable or invalid slots: %s', count => {
    expect(rankLanes('frontier', snapshot(), { 'codex-cmp': count })).toEqual([]);
  });
  it('excludes exhausted, held, unknown and reset-pending budgets', () => {
    for (const state of ['exhausted', 'held', 'unknown', 'reset-pending'] as const) {
      const input = snapshot(); const view = input.budgets.pools['codex-cmp'];
      if (state === 'held') view.mode = 'held';
      else if (state === 'exhausted') view.buckets.weeklyPct!.remaining = 0;
      else view.buckets.weeklyPct!.state = state;
      expect(rankLanes('frontier', input, { 'codex-cmp': 1 })).toEqual([]);
    }
  });
  it('refuses unknown routes, tier downgrades, fallback backends and unavailable sources', () => {
    const input = snapshot(); expect(rankLanes('mid', input, slots)).toEqual([]);
    input.routes = {}; expect(rankLanes('frontier', input, slots)).toEqual([]);
    input.routes['codex-cmp'] = { backend: 'builtin', tier: 'frontier', reason: 'fallback' };
    expect(rankLanes('frontier', input, slots)).toEqual([]);
    const unavailable = snapshot(); unavailable.budgets.sourceState = 'unavailable'; expect(rankLanes('frontier', unavailable, slots)).toEqual([]);
  });
  it.each([now, 'invalid'])('rejects expired or malformed reset evidence: %s', reset => {
    const input = snapshot(); input.budgets.pools['codex-cmp'].buckets.weeklyPct!.resetAt = reset;
    expect(rankLanes('frontier', input, { 'codex-cmp': 1 })).toEqual([]);
  });
  it('CLI consumes route decisions without invoking the router and emits ranked JSON', async () => {
    const input = snapshot();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 100 } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(input.routes));
    vi.mocked(readPoolBudgets).mockResolvedValue(input.budgets);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdRouter(['rank', '--routes', 'routes.json', '--tier', 'frontier', '--slots', 'codex-cmp=2', '--slots', 'codex-personal=1', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).lanes.map((l: { pool: string }) => l.pool)).toEqual(['codex-personal', 'codex-cmp']);
    expect(await cmdRouter(['rank', '--tier', 'frontier', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).lanes).toEqual([]);
  });
  it('CLI rejects invalid arguments before reading state and sanitizes failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [[], ['rank'], ['rank', '--tier', 'bad'], ['rank', '--tier', 'mid', '--slots', 'codex-cmp=-1']]) expect(await cmdRouter(args)).toBe(2);
    expect(readPoolBudgets).not.toHaveBeenCalled();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 100 } as Awaited<ReturnType<typeof stat>>);
    for (const text of ['not JSON', 'null', '[]']) {
      vi.mocked(readFile).mockResolvedValue(text);
      expect(await cmdRouter(['rank', '--tier', 'mid', '--routes', 'routes.json'])).toBe(1);
    }
    vi.mocked(readPoolBudgets).mockRejectedValue(new Error('private detail'));
    expect(await cmdRouter(['rank', '--tier', 'mid', '--json'])).toBe(1);
    expect(error.mock.calls.at(-1)).toEqual(['Router rank unavailable.']);
  });
});
