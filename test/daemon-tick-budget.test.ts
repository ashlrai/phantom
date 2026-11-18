/**
 * Whole-tick budget (tick-phases.ts): per-phase deadlines no longer add up to
 * a tick that runs for their sum. Phases share one budget; dispatch is exempt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginTickPhases,
  endTickPhases,
  resetTickPhasesForTests,
  runTickPhase,
  tickBudgetRemainingMs,
  TICK_BUDGET_EXHAUSTED,
  TICK_BUDGET_MS,
  TICK_PHASE_MAINTENANCE_MS,
} from '../src/core/daemon/tick-phases.js';

const never = (signal: AbortSignal): Promise<string> => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

afterEach(() => resetTickPhasesForTests());

describe('whole-tick budget', () => {
  it('stays under the 15 min admission staleness bound', () => {
    expect(TICK_BUDGET_MS).toBeLessThan(15 * 60_000);
  });

  it('clamps a phase deadline to what is left of the tick budget', async () => {
    beginTickPhases({ budgetMs: 1_200 });
    const started = Date.now();
    const run = await runTickPhase('self-heal', never, { deadlineMs: TICK_PHASE_MAINTENANCE_MS, graceMs: 0 });
    expect(run.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(endTickPhases().map((p) => p.name)).toEqual(['self-heal']);
  });

  it('skips phases that start after the budget is spent, without running them', async () => {
    let clock = 1_000_000;
    const nowMs = (): number => clock;
    beginTickPhases({ budgetMs: 10 * 60_000, nowMs: clock });
    // post-merge watch (tick hooks) and a backlog refresh use the whole budget...
    clock += 10 * 60_000;
    expect(tickBudgetRemainingMs(clock)).toBe(0);
    let ran = false;
    const skipped = await runTickPhase('backlog-refresh', async () => { ran = true; return []; },
      { deadlineMs: 5 * 60_000, nowMs });
    expect(skipped).toMatchObject({ status: 'skipped', error: TICK_BUDGET_EXHAUSTED, durationMs: 0 });
    expect(ran).toBe(false);
    // ...but already admitted dispatch still runs.
    const dispatch = await runTickPhase('dispatch', async () => 'ok', { deadlineMs: 60_000, nowMs, budgetExempt: true });
    expect(dispatch).toMatchObject({ status: 'ok', value: 'ok' });
    expect(endTickPhases()).toEqual([
      { name: 'backlog-refresh', status: 'skipped', durationMs: 0, error: TICK_BUDGET_EXHAUSTED },
      expect.objectContaining({ name: 'dispatch', status: 'ok' }),
    ]);
  });

  it('a tick without a budget keeps per-phase deadlines only, and the next tick starts fresh', async () => {
    beginTickPhases({ budgetMs: 0 });
    expect((await runTickPhase('ancillary', async () => 1, { deadlineMs: 1_000 })).status).toBe('skipped');
    endTickPhases();
    expect(tickBudgetRemainingMs()).toBeNull();
    beginTickPhases();
    expect((await runTickPhase('ancillary', async () => 1, { deadlineMs: 1_000 })).status).toBe('ok');
  });
});
