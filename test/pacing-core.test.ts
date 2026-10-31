import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFleetReadings, planHorizon, safetyBuffer, type MilpSolver } from '../src/core/resources/pacing/index.js';

describe('receding horizon and manual readings', () => {
  const day = 86_400_000;
  const start = Date.parse('2026-10-26T00:00:00.000Z');
  const reset = start + 4 * day;
  const knobs = {
    bufferFraction: 0,
    bufferWindowMs: 12 * 3_600_000,
    reserveFraction: 0,
    flex: 2,
    deviationWeight: 0.05,
    flexPenalty: 10,
    landingWeight: 100,
    periodMs: day,
    maxPeriods: 8,
  };

  it('shrinks the buffer, holds a pool that is ahead, and paces the final window', async () => {
    expect(safetyBuffer(12 * 3_600_000, 0.2, 12 * 3_600_000)).toBeCloseTo(0.2);
    expect(safetyBuffer(6 * 3_600_000, 0.2, 12 * 3_600_000)).toBeCloseTo(0.1);
    expect(safetyBuffer(0, 0.2, 12 * 3_600_000)).toBe(0);
    expect(safetyBuffer(48 * 3_600_000, 0.2, 12 * 3_600_000)).toBeCloseTo(0.2);

    const ahead = await planHorizon({
      poolId: 'grok-ultra-weekly',
      used: 0.8,
      nowMs: start,
      resetAtMs: reset,
      windowStartMs: start,
      values: [1, 1, 1, 1],
      knobs,
    });
    expect(ahead.allowance).toBe(0);
    expect(ahead.series.isReading).toBe(false);

    const hold = { ...knobs, bufferFraction: 0.2, periodMs: 12 * 3_600_000 };
    const window = 12 * 3_600_000;
    const far = await planHorizon({
      poolId: 'claude',
      used: 0,
      nowMs: reset - window,
      resetAtMs: reset,
      windowStartMs: reset - window,
      knobs: hold,
    });
    const mid = await planHorizon({
      poolId: 'claude',
      used: 0,
      nowMs: reset - window / 2,
      resetAtMs: reset,
      windowStartMs: reset - window,
      knobs: hold,
    });
    const end = await planHorizon({
      poolId: 'claude',
      used: 0,
      nowMs: reset,
      resetAtMs: reset,
      windowStartMs: reset - window,
      knobs: hold,
    });
    expect(far.allowance).toBeCloseTo(0.8, 1);
    expect(mid.allowance).toBeCloseTo(0.9, 1);
    expect(end.allowance).toBeCloseTo(1, 1);
  });

  it('flags a stale manual reading and keeps the projection derived', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-readings-'));
    const path = join(dir, 'fleet.json');
    const now = Date.parse('2026-10-26T12:00:00.000Z');
    writeFileSync(path, JSON.stringify({
      readings: [
        { poolId: 'claude', value: 0.4, timestamp: '2026-10-20T12:00:00.000Z', source: 'manual' },
        { poolId: 'codex-primary', value: 0.2, timestamp: '2026-10-26T11:00:00.000Z', source: 'manual' },
        { poolId: 'devin', value: 0.1, timestamp: '2026-10-26T11:00:00.000Z', source: 'api' },
      ],
    }));
    const staleAfterMs = 24 * 3_600_000;
    const rows = loadFleetReadings({ path, nowMs: now, staleAfterMs });
    const claude = rows.find((row) => row.poolId === 'claude');
    const codex = rows.find((row) => row.poolId === 'codex-primary');
    expect(claude?.stale).toBe(true);
    expect(claude?.projection).toBe('derived');
    expect(claude?.isReading).toBe(false);
    expect(claude?.source).toBe('manual');
    expect(claude?.ageMs).toBe(6 * 24 * 3_600_000);
    expect(claude?.uncertainty).toBeGreaterThan(codex?.uncertainty ?? 1);
    expect(codex?.stale).toBe(false);
    expect(rows.find((row) => row.poolId === 'devin')).toBeUndefined();
    const fromEnv = loadFleetReadings({
      env: { PHANTOM_FLEET_FILE: path },
      nowMs: now,
      staleAfterMs,
    });
    expect(fromEnv).toHaveLength(2);
  });
  it('falls back to the even plan when the injected solver fails, and still lands at reset', async () => {
    const failing: MilpSolver = async () => ({ status: 'failed', objective: null, values: {} });
    const throwing: MilpSolver = async () => { throw new Error('solver unavailable'); };
    const lp: string[] = [];
    const recording: MilpSolver = async (text) => { lp.push(text); return { status: 'timeout', objective: null, values: {} }; };
    const curve = [0.2, 2, 0.2, 2];
    for (const solver of [failing, throwing, recording]) {
      const plan = await planHorizon({ poolId: 'codex-primary', used: 0, nowMs: start, resetAtMs: reset, windowStartMs: start, values: curve, knobs, solver, solverBudgetMs: 50 });
      expect(plan.solver).toBe('greedy');
      expect(plan.series.projection).toBe('derived');
      expect(plan.series.isReading).toBe(false);
    }
    expect(lp.length).toBe(1);
    expect(lp[0]!.length).toBeGreaterThan(0);
    let used = 0;
    let now = start;
    while (now < reset - 1_000) {
      const plan = await planHorizon({ poolId: 'codex-primary', used, nowMs: now, resetAtMs: reset, windowStartMs: start, knobs });
      used += Math.min(1 - used, plan.allowance);
      expect(used).toBeLessThanOrEqual(1 + 1e-4);
      now += day;
    }
    expect(used).toBeGreaterThan(0.97);
  });
});
