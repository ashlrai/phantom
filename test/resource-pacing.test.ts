import { afterEach, describe, expect, it, vi } from 'vitest';
import { paceWindow, planHorizon, safetyBuffer, type HorizonKnobs, type PaceSolver } from '../src/core/resources/pacing.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const knobs: HorizonKnobs = {
  bufferFraction: 0.02, bufferWindowMs: 12 * HOUR, reserveFraction: 0,
  flex: 1.5, deviationWeight: 0.05, flexPenalty: 10, landingWeight: 100,
  periodMs: DAY, maxPeriods: 24,
};
const window = {
  poolId: 'grok-ultra-weekly', used: 0.36, windowStartMs: 0,
  nowMs: DAY, resetAtMs: 7 * DAY, knobs,
};
const lpWindow = {
  ...window, used: 0, nowMs: 0, resetAtMs: 2 * DAY, values: [1, 3],
  knobs: { ...knobs, bufferFraction: 0, flex: 1, deviationWeight: 0, flexPenalty: 0 },
};
afterEach(() => { vi.useRealTimers(); });

describe('resource pacing core', () => {
  it('waits when ahead of pace and lands within the remaining quota at reset', () => {
    const plan = paceWindow(window);
    expect(plan.allowance).toBe(0);
    expect(plan.spends.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.64, 12);
    expect(plan.projectedLanding).toBeCloseTo(1, 12);
    let used = window.used;
    plan.periods.forEach((period, index) => {
      used += plan.spends[index]!;
      expect(used).toBeLessThanOrEqual(period.ceiling + 1e-12);
      expect(used).toBeLessThanOrEqual(1 + 1e-12);
    });
  });

  it('replans unused allowance instead of discarding it between ticks', () => {
    const first = paceWindow({ ...window, used: 0, nowMs: 0 });
    const idle = paceWindow({ ...window, used: 0, nowMs: DAY });
    expect(first.allowance).toBeGreaterThan(0);
    expect(idle.projectedLanding).toBeCloseTo(1, 12);
    expect(idle.spends.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(idle.allowance).toBeGreaterThanOrEqual(first.allowance);
  });

  it('simulates one entire reset window with partial utilization and no overspend', () => {
    let used = 0.36;
    for (let nowMs = DAY; nowMs < 7 * DAY; nowMs += HOUR) {
      const plan = paceWindow({ ...window, nowMs, used, knobs: { ...knobs, periodMs: HOUR } });
      const spent = plan.allowance * (nowMs < 3 * DAY ? 0.5 : 1);
      expect(spent).toBeGreaterThanOrEqual(0);
      used += spent;
      expect(used).toBeLessThanOrEqual(1);
    }
    expect(used).toBeGreaterThan(0.99);
    expect(paceWindow({ ...window, used, nowMs: 7 * DAY }).allowance).toBe(0);
  });

  it('releases safety and orchestration holds linearly in the final twelve hours', () => {
    expect(safetyBuffer(24 * HOUR, 0.15, 12 * HOUR)).toBe(0.15);
    expect(safetyBuffer(6 * HOUR, 0.15, 12 * HOUR)).toBe(0.075);
    expect(safetyBuffer(0, 0.15, 12 * HOUR)).toBe(0);
    const end = { ...window, used: 0.9, nowMs: 7 * DAY - 6 * HOUR };
    const total = paceWindow(end);
    const cloud = paceWindow({ ...end, knobs: { ...knobs, reserveFraction: 0.15 } });
    expect(total.allowance).toBeCloseTo(0.09, 12);
    expect(cloud.allowance).toBeCloseTo(0.015, 12);
    expect(cloud.projectedLanding).toBeCloseTo(1, 12);
  });

  it.each([7 * DAY, 8 * DAY])('does not reuse quota at or after reset (%s)', (nowMs) => {
    const plan = paceWindow({ ...window, nowMs });
    expect(plan.allowance).toBe(0);
    expect(plan.periods).toEqual([]);
    expect(plan.spends).toEqual([]);
    expect(plan.projectedLanding).toBe(window.used);
  });

  it('requires a new window and usage value to plan the next cycle', () => {
    const plan = paceWindow({ ...window, used: 0, windowStartMs: 7 * DAY, nowMs: 7 * DAY, resetAtMs: 14 * DAY });
    expect(plan.allowance).toBeGreaterThan(0);
    expect(plan.projectedLanding).toBeCloseTo(1, 12);
  });

  it('handles exhausted quota, one remaining millisecond, and bounded coarse horizons', () => {
    expect(paceWindow({ ...window, used: 1 }).allowance).toBe(0);
    expect(paceWindow({ ...window, used: 1 }).spends.every((v) => v === 0)).toBe(true);
    const last = paceWindow({ ...window, nowMs: 7 * DAY - 1 });
    expect(last.periods).toHaveLength(1);
    expect(last.periods[0]!.endMs).toBe(7 * DAY);
    expect(last.allowance).toBeGreaterThan(0);
    expect(last.allowance).toBeLessThanOrEqual(1 - window.used);
    const coarse = paceWindow({ ...window, knobs: { ...knobs, periodMs: 1, maxPeriods: 3 } });
    expect(coarse.periods).toHaveLength(3);
    expect(coarse.periods.at(-1)!.endMs).toBe(window.resetAtMs);
    expect(coarse.projectedLanding).toBeCloseTo(1, 12);
  });

  it('distinguishes old manual readings from derived current and future points', () => {
    const plan = paceWindow({ ...window,
      stamp: { source: 'manual', atMs: 0, ageMs: DAY, stale: true, uncertainty: 0.75 } });
    expect(plan.series).toMatchObject({ isReading: false, projection: 'derived',
      stale: true, readingAgeMs: DAY, readingSource: 'manual', uncertainty: 0.75 });
    expect(plan.series.points[0]).toMatchObject({ atMs: 0, actualCumulative: 0.36, projectedCumulative: null });
    expect(plan.series.points.slice(1).every((point) => point.actualCumulative === null)).toBe(true);
    expect(paceWindow(window).series).toMatchObject({
      actualCumulative: null, readingSource: null, readingAgeMs: null, uncertainty: 1, stale: true,
    });
    expect(paceWindow(window).series.points.every((point) => point.actualCumulative === null)).toBe(true);
  });

  it('preserves a current config reading at its own timestamp', () => {
    const plan = paceWindow({ ...window,
      stamp: { source: 'config', atMs: DAY, ageMs: 0, stale: false, uncertainty: 0.1 } });
    expect(plan.series.points[0]).toMatchObject({ atMs: DAY, actualCumulative: 0.36 });
    expect(plan.series.points.slice(1).every((point) => point.actualCumulative === null)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, -0.1, 1.1])('rejects invalid quota %s', (used) => {
    expect(() => paceWindow({ ...window, used })).toThrow(RangeError);
  });

  it.each([
    { nowMs: NaN }, { nowMs: -1 }, { resetAtMs: Infinity },
    { resetAtMs: 0 }, { windowStartMs: 8 * DAY },
  ])('rejects invalid times %j', (invalid) => {
    expect(() => paceWindow({ ...window, ...invalid })).toThrow(RangeError);
  });

  it.each([
    { maxPeriods: 0 }, { maxPeriods: 257 }, { maxPeriods: 1.5 }, { maxPeriods: Infinity },
    { periodMs: NaN }, { periodMs: 0 }, { periodMs: Infinity },
    { bufferFraction: NaN }, { reserveFraction: -0.1 }, { reserveFraction: 1 },
    { bufferWindowMs: 0 }, { flex: NaN }, { flex: 0.5 },
    { deviationWeight: -1 }, { flexPenalty: Infinity }, { landingWeight: NaN },
  ])('rejects unsafe horizon controls %j', (invalid) => {
    expect(() => paceWindow({ ...window, knobs: { ...knobs, ...invalid } })).toThrow(RangeError);
  });

  it.each([
    { atMs: DAY + 1, ageMs: 0 }, { ageMs: -1 }, { ageMs: 1 }, { uncertainty: NaN },
  ])('rejects inconsistent reading metadata %j', (invalid) => {
    expect(() => paceWindow({ ...window,
      stamp: { source: 'manual', atMs: 0, ageMs: DAY, stale: true, uncertainty: 1, ...invalid } })).toThrow(RangeError);
  });

  it.each([[NaN, 0.1, HOUR], [HOUR, -0.1, HOUR], [HOUR, 0.1, 0]])(
    'rejects invalid safety buffer arguments (%s, %s, %s)', (left, fraction, duration) => {
      expect(() => safetyBuffer(left!, fraction!, duration!)).toThrow(RangeError);
    });
});

describe('optional pacing LP', () => {
  it('accepts a better feasible value curve and sends cumulative, deviation, flex and landing constraints', async () => {
    const solver = vi.fn<PaceSolver>(async () => ({ status: 'optimal', values: { s0: 0, s1: 1 } }));
    const plan = await planHorizon({ ...lpWindow, solver, solverBudgetMs: 50 });
    expect(plan.solver).toBe('lp');
    expect(plan.spends).toEqual([0, 1]);
    expect(plan.allowance).toBe(0);
    expect(plan.projectedLanding).toBe(1);
    const [lp, budget] = solver.mock.calls[0]!;
    expect(budget).toBe(50);
    expect(lp).toContain('1.000000000000 s0');
    expect(lp).toContain('3.000000000000 s1');
    expect(lp).toContain('cum0: s0 <= 0.500000000000');
    expect(lp).toContain('cum1: s0 + s1 <= 1.000000000000');
    expect(lp).toContain('devhi0: s0 - d0 <= 0.500000000000');
    expect(lp).toContain('devlo0: - s0 - d0 <= -0.500000000000');
    expect(lp).toContain('flex0: s0 - o0 <= 0.500000000000');
    expect(lp).toContain('land: s0 + s1 + short = 1.000000000000');
    expect(plan.spends[0]! + 3 * plan.spends[1]!).toBeGreaterThan(2);
  });

  it('uses the even plan without an adapter or for constant values', async () => {
    const solver = vi.fn<PaceSolver>();
    expect((await planHorizon(lpWindow)).solver).toBe('even');
    expect((await planHorizon({ ...lpWindow, solver, values: [2, 2] })).spends).toEqual([0.5, 0.5]);
    expect(solver).not.toHaveBeenCalled();
  });

  it.each(['infeasible', 'failed', 'timeout'] as const)('falls back on solver status %s', async (status) => {
    const plan = await planHorizon({ ...lpWindow, solver: async () => ({ status, values: {} }) });
    expect(plan.solver).toBe('even');
    expect(plan.spends).toEqual([0.5, 0.5]);
  });

  it.each([
    {}, { s0: NaN, s1: 1 }, { s0: Infinity, s1: 0 },
    { s0: -0.1, s1: 1.1 }, { s0: 0.51, s1: 0.49 },
    { s0: 0.5, s1: 0.51 }, { s0: 0.2, s1: 0.2 },
  ])('rejects malformed, overspending or incomplete solver spends %j', async (values) => {
    const plan = await planHorizon({ ...lpWindow, solver: async () => ({ status: 'optimal', values }) });
    expect(plan.solver).toBe('even');
    expect(plan.spends).toEqual([0.5, 0.5]);
  });

  it('removes solver roundoff without granting more than the cumulative ceiling', async () => {
    const plan = await planHorizon({ ...lpWindow,
      solver: async () => ({ status: 'optimal', values: { s0: 0.5 + 1e-10, s1: 0.5 } }) });
    expect(plan.solver).toBe('lp');
    expect(plan.spends).toEqual([0.5, 0.5]);
    expect(plan.allowance).toBe(0.5);
  });

  it('falls back after an exception or malformed solver result', async () => {
    expect((await planHorizon({ ...lpWindow, solver: async () => { throw new Error('failed'); } })).solver).toBe('even');
    expect((await planHorizon({ ...lpWindow,
      solver: (async () => null) as unknown as PaceSolver })).solver).toBe('even');
  });

  it('bounds an unresponsive asynchronous solver and clears its deadline', async () => {
    vi.useFakeTimers();
    const pending = planHorizon({ ...lpWindow, solverBudgetMs: 25, solver: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(25);
    const plan = await pending;
    expect(plan.solver).toBe('even');
    expect(plan.spends).toEqual([0.5, 0.5]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('snapshots controls across an asynchronous solve', async () => {
    const input = { ...lpWindow, knobs: { ...lpWindow.knobs }, values: [1, 3] };
    const solver: PaceSolver = async () => {
      input.knobs.bufferFraction = 1;
      input.values[1] = NaN;
      input.used = 1;
      return { status: 'optimal', values: { s0: 0.5, s1: 0.5 } };
    };
    const plan = await planHorizon({ ...input, solver });
    expect(plan.allowance).toBe(0.5);
    expect(plan.projectedLanding).toBe(1);
  });

  it.each([
    { values: [NaN, 1] }, { values: [1, Infinity] }, { solverBudgetMs: 0 },
    { solverBudgetMs: NaN }, { solverBudgetMs: 60_001 },
  ])('rejects invalid objectives or budgets %j', async (invalid) => {
    await expect(planHorizon({ ...lpWindow, ...invalid })).rejects.toThrow(RangeError);
  });
});
