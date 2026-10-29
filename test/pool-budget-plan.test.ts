import { describe, expect, it } from 'vitest';
import { projectPoolBudgets, type BudgetPool, type BudgetReading, type PoolBudgetSnapshot } from '../src/core/fleet/pool-budget.js';
import { GROK_ULTRA_MAX_CONCURRENCY, PACE_TOLERANCE, projectPoolBudgetPlan } from '../src/core/fleet/pool-budget-plan.js';

const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const RESET = at(48 * HOUR);

function reading(pool: BudgetPool, bucket: BudgetReading['bucket'], remaining: number, hoursAgo: number, resetAt: string | null = RESET): BudgetReading {
  return { pool, bucket, remaining, timestamp: at(-hoursAgo * HOUR), resetAt, source: 'log' };
}
function snapshot(rows: BudgetReading[], sourceState: PoolBudgetSnapshot['sourceState'] = 'healthy'): PoolBudgetSnapshot {
  return projectPoolBudgets(rows, new Date(T0), sourceState);
}
function plan(rows: BudgetReading[], sourceState: PoolBudgetSnapshot['sourceState'] = 'healthy') {
  return projectPoolBudgetPlan(snapshot(rows, sourceState), T0);
}

describe('pool budget plan lanes', () => {
  it('emits the fleet.budget-plan.v1 schema for every pool', () => {
    const p = plan([]);
    expect(p.schema).toBe('fleet.budget-plan.v1');
    expect(p.timestamp).toBe(at(0));
    expect(p.targetUsedPercent).toBe(98);
    expect(p.tolerance).toBe(PACE_TOLERANCE);
    expect(Object.keys(p.decisions)).toEqual(['codex-cmp', 'codex-personal', 'devin', 'claude', 'grok-build', 'local-omlx', 'grok-ultra']);
    for (const d of Object.values(p.decisions)) expect(d.reasons.length).toBeGreaterThan(0);
  });
  it('opens weekly and keeps credits closed while weekly remains', () => {
    const d = plan([reading('codex-cmp', 'weeklyPct', 60, 2), reading('codex-cmp', 'credits', 500, 2)]).decisions['codex-cmp'];
    expect(d).toMatchObject({ lane: 'weekly', weeklyOpen: true, creditsOpen: false, weeklyRemainingPct: 60, creditsRemaining: 500 });
    expect(d.reasons.join(' ')).toMatch(/before credits/);
  });
  it('opens the credits lane only after observed weekly exhaustion', () => {
    const d = plan([reading('codex-cmp', 'weeklyPct', 0, 1), reading('codex-cmp', 'credits', 500, 1)]).decisions['codex-cmp'];
    expect(d).toMatchObject({ lane: 'credits', weeklyOpen: false, creditsOpen: true, concurrency: 'hold' });
    expect(d.reasons.join(' ')).toMatch(/exhausted/);
  });
  it('pauses when weekly and credits are both exhausted', () => {
    const d = plan([reading('codex-cmp', 'weeklyPct', 0, 1), reading('codex-cmp', 'credits', 0, 1)]).decisions['codex-cmp'];
    expect(d).toMatchObject({ lane: 'none', weeklyOpen: false, creditsOpen: false, concurrency: 'pause' });
  });
  it('keeps credits closed across a weekly reset boundary', () => {
    const rows = [reading('codex-cmp', 'weeklyPct', 0, 2, at(-HOUR)), reading('codex-cmp', 'credits', 500, 1)];
    const d = plan(rows).decisions['codex-cmp'];
    expect(d).toMatchObject({ weeklyOpen: false, creditsOpen: false, concurrency: 'hold', lane: 'none' });
    expect(d.reasons.join(' ')).toMatch(/reset passed/i);
  });
  it('keeps credits closed while weekly is unobserved', () => {
    const d = plan([reading('codex-cmp', 'credits', 500, 1)]).decisions['codex-cmp'];
    expect(d).toMatchObject({ weeklyOpen: false, creditsOpen: false, concurrency: 'hold', lane: 'none' });
    expect(d.reasons.join(' ')).toMatch(/unobserved/i);
  });
});

describe('pool budget plan pace', () => {
  const burn = (pool: BudgetPool, first: number, second: number, gapHours = 2): BudgetReading[] => [
    reading(pool, 'weeklyPct', first, gapHours * 2), reading(pool, 'weeklyPct', second, gapHours),
  ];
  it('raises concurrency under pace and lowers it over pace', () => {
    // 60% left, 48h to reset: target is (60-2)/48 = 1.208%/h. Burning 0.5/h is under pace.
    const under = plan(burn('codex-cmp', 61, 60)).decisions['codex-cmp'];
    expect(under.concurrency).toBe('raise');
    expect(under.targetBurnPerHour).toBeCloseTo(58 / 48, 5);
    expect(under.observedBurnPerHour).toBeCloseTo(0.5, 5);
    expect(under.paceRatio).toBeCloseTo(0.5 / (58 / 48), 5);
    // Burning 2.5%/h is over pace.
    const over = plan(burn('codex-cmp', 65, 60)).decisions['codex-cmp'];
    expect(over.concurrency).toBe('lower');
    expect(over.paceRatio).toBeGreaterThan(1 + PACE_TOLERANCE);
  });
  it('holds on pace and raises when no burn is observed', () => {
    // 48% left, 48h: target 46/48 = 0.958%/h. Burn 1%/h is inside tolerance.
    const onPace = plan(burn('codex-cmp', 50, 48)).decisions['codex-cmp'];
    expect(onPace.concurrency).toBe('hold');
    expect(onPace.paceRatio).toBeCloseTo(1 / (46 / 48), 5);
    const silent = plan([reading('codex-cmp', 'weeklyPct', 60, 1)]).decisions['codex-cmp'];
    expect(silent).toMatchObject({ concurrency: 'raise', observedBurnPerHour: null, paceRatio: null });
  });
  it('protects the landing margin once the target is met', () => {
    const easing = plan(burn('codex-cmp', 3, 1.5)).decisions['codex-cmp'];
    expect(easing).toMatchObject({ concurrency: 'lower', targetBurnPerHour: 0 });
    const resting = plan([reading('codex-cmp', 'weeklyPct', 1.5, 1)]).decisions['codex-cmp'];
    expect(resting).toMatchObject({ concurrency: 'hold', targetBurnPerHour: 0 });
  });
  it('holds when the reset is unknown', () => {
    const d = plan([reading('codex-cmp', 'weeklyPct', 60, 1, null)]).decisions['codex-cmp'];
    expect(d).toMatchObject({ lane: 'weekly', weeklyOpen: true, concurrency: 'hold', targetBurnPerHour: null, hoursToReset: null });
    expect(d.reasons.join(' ')).toMatch(/reset is unknown/i);
  });
});

describe('pool-specific policy', () => {
  it('keeps Grok Ultra a scarce orchestration pool capped at one dispatch', () => {
    const d = plan([reading('grok-ultra', 'weeklyPct', 80, 3), reading('grok-ultra', 'weeklyPct', 78, 1)]).decisions['grok-ultra'];
    expect(d.maxConcurrency).toBe(GROK_ULTRA_MAX_CONCURRENCY);
    expect(d.concurrency).toBe('raise');
    expect(d.reasons.join(' ')).toMatch(/scarce orchestration/);
    const spent = plan([reading('grok-ultra', 'weeklyPct', 0, 1), reading('grok-ultra', 'credits', 10, 1)]).decisions['grok-ultra'];
    expect(spent).toMatchObject({ lane: 'credits', creditsOpen: true, maxConcurrency: 1 });
  });
  it('paces Devin ACUs to zero at reset and pauses when exhausted', () => {
    const rows: BudgetReading[] = [
      { pool: 'devin', bucket: 'acus', remaining: 120, timestamp: at(-4 * HOUR), resetAt: RESET, source: 'log' },
      { pool: 'devin', bucket: 'acus', remaining: 115, timestamp: at(-HOUR), resetAt: RESET, source: 'log' },
    ];
    const d = plan(rows).decisions.devin;
    expect(d).toMatchObject({ lane: 'metered', concurrency: 'raise', meteredRemaining: 115 });
    expect(d.targetBurnPerHour).toBeCloseTo(115 / 48, 5);
    const spent = plan([{ ...rows[1]!, remaining: 0 }]).decisions.devin;
    expect(spent).toMatchObject({ concurrency: 'pause' });
  });
  it('holds the held Claude pool at pause and bounds local capacity', () => {
    const p = plan([{ pool: 'local-omlx', bucket: 'capacity', remaining: 2, timestamp: at(-HOUR), resetAt: null, source: 'log' }]);
    expect(p.decisions.claude).toMatchObject({ lane: 'held', concurrency: 'pause' });
    expect(p.decisions['local-omlx']).toMatchObject({ lane: 'capacity', concurrency: 'hold', maxConcurrency: 2, meteredRemaining: 2 });
    const empty = plan([{ pool: 'local-omlx', bucket: 'capacity', remaining: 0, timestamp: at(-HOUR), resetAt: null, source: 'log' }]);
    expect(empty.decisions['local-omlx']).toMatchObject({ concurrency: 'pause', maxConcurrency: 0 });
  });
  it('holds every pool when the ledger is unavailable', () => {
    const p = plan([reading('codex-cmp', 'weeklyPct', 60, 1)], 'unavailable');
    expect(p.sourceState).toBe('unavailable');
    for (const d of Object.values(p.decisions)) {
      expect(d.concurrency).toBe('hold');
      expect(d.lane).toBe('none');
      expect(d.reasons.join(' ')).toMatch(/unavailable/);
    }
  });
});
