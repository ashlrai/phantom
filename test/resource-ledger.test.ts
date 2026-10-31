import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildResourceLedger } from '../src/core/fabric/resource-ledger.js';
import { projectPoolBudgets, type BudgetReading } from '../src/core/fleet/pool-budget.js';
import type { ResourceSnapshot } from '../src/core/fabric/resource-monitor.js';
import { cmdResources } from '../src/cli/resources.js';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 29) + hour * 3_600_000).toISOString();
const reading = (remaining: number, hour: number, extra: Partial<BudgetReading> = {}): BudgetReading => ({
  pool: 'codex-cmp', bucket: 'weeklyPct', remaining, timestamp: at(hour), resetAt: at(12), source: 'log', ...extra,
});
const snapshot: ResourceSnapshot = { generatedAt: at(10), backends: [{ backend: 'codex', availability: 'open',
  usedPct: 25, cap: 100, capUnit: 'requests', capWindow: '5h', resetsAt: Date.parse(at(14)) / 1000,
  costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: at(10), reason: '', backoffUntilMs: null }] };
const bucket = (rows: BudgetReading[], hour = 11.75) => projectPoolBudgets(rows, new Date(at(hour))).pools['codex-cmp'].buckets.weeklyPct!;
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/fabric/resource-monitor.js', () => ({ getResourceSnapshot: vi.fn() }));
vi.mock('../src/core/fleet/pool-budget-store.js', () => ({ readPoolBudgets: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe('resource ledger', () => {
  it('preserves missing or unavailable budgets as unknown, including pool-only backends', () => {
    const ledger = buildResourceLedger({ generatedAt: at(10), backends: [] }, projectPoolBudgets([], new Date(at(10)), 'unavailable'));
    expect(ledger.sourceState).toBe('unavailable');
    for (const backend of ledger.backends) {
      expect(backend.availability).toBe('unknown');
      expect(backend.monitor).toEqual({ leftPct: null, resetAt: null, observedAt: null });
      for (const pool of backend.pools) for (const b of Object.values(pool.buckets)) {
        expect(b).toMatchObject({ remaining: null, burnPerHour: { last2: null, last12h: null },
          projectedExhaustion: null, usageInLastHourBeforeReset: null });
      }
    }
  });
  it('projects exhaustion before reset without conflating accounts, credits or monitor windows', () => {
    const ledger = buildResourceLedger(snapshot, projectPoolBudgets([reading(30, 9), reading(10, 10),
      reading(40, 10, { bucket: 'credits', resetAt: null })], new Date(at(10))));
    const codex = ledger.backends.find(b => b.backend === 'codex')!;
    expect(codex.monitor).toEqual({ leftPct: 75, resetAt: at(14), observedAt: at(10) });
    expect(codex.pools[0]?.buckets.weeklyPct).toMatchObject({ remaining: 10, resetAt: at(12),
      burnPerHour: { last2: 20 }, projectedExhaustion: at(10.5) });
    expect(codex.pools[0]?.remainingCredits).toBe(40);
    expect(codex.pools[1]?.remainingWeeklyPct).toBeNull();
    expect(bucket([reading(30, 9), reading(20, 10)]).projectedExhaustion).toBeNull();
    expect(buildResourceLedger(snapshot, projectPoolBudgets([], new Date(at(14)))).backends[0]?.monitor.leftPct).toBeNull();
  });
  it('reports only observed final-hour deltas and retains their interval after reset', () => {
    const rows = [reading(90, 10), reading(70, 11), reading(60, 11.5), reading(55, 11.75)];
    expect(bucket(rows).usageInLastHourBeforeReset).toEqual({ used: 15, from: at(11), to: at(11.75) });
    expect(bucket(rows, 12)).toMatchObject({ remaining: null, state: 'reset-pending',
      projectedExhaustion: null, usageInLastHourBeforeReset: { used: 15, from: at(11), to: at(11.75) } });
    expect(bucket([reading(70, 11.25), reading(70, 11.5)]).usageInLastHourBeforeReset?.used).toBe(0);
    expect(bucket([reading(70, 11), reading(60, 12.5, { resetAt: at(14) })], 13).usageInLastHourBeforeReset).toBeNull();
  });
  it.each([
    [reading(90, 10), reading(70, 11)], [reading(70, 11), reading(90, 11.5)],
    [reading(70, 11), reading(60, 11.5, { resetAt: at(13) })],
    [reading(70, 11, { source: 'manual' }), reading(60, 11.5)],
    [reading(70, 11, { resetAt: null }), reading(60, 11.5, { resetAt: null })],
  ])('does not invent final-hour usage from insufficient or incomparable readings: %j', (...rows) => {
    expect(bucket(rows).usageInLastHourBeforeReset).toBeNull();
  });
  it.each([null, NaN, Infinity, -1, 101])('keeps invalid monitor usage unknown: %s', usedPct => {
    const input = { ...snapshot, backends: [{ ...snapshot.backends[0]!, usedPct }] };
    expect(buildResourceLedger(input, projectPoolBudgets([], new Date(at(10)))).backends[0]?.monitor.leftPct).toBeNull();
  });
  it('keeps capacity out of spend calculations', () => {
    const rows = [reading(8, 11), reading(4, 11.5)].map(r => ({ ...r, pool: 'local-omlx' as const, bucket: 'capacity' as const }));
    expect(projectPoolBudgets(rows, new Date(at(11.5))).pools['local-omlx'].buckets.capacity).toMatchObject({
      remaining: 4, burnPerHour: { last2: null }, usageInLastHourBeforeReset: null });
  });
  it('CLI emits one ledger JSON object from existing readers and preserves plain --json', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const { readPoolBudgets } = await import('../src/core/fleet/pool-budget-store.js');
    vi.mocked(getResourceSnapshot).mockResolvedValue(snapshot);
    const budgets = projectPoolBudgets([reading(30, 9), reading(10, 10)], new Date(at(10)));
    vi.mocked(readPoolBudgets).mockResolvedValue(budgets);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdResources(['--ledger', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(buildResourceLedger(snapshot, budgets));
    log.mockClear();
    expect(await cmdResources(['--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(snapshot);
  });
});
