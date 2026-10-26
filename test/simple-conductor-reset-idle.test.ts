/**
 * simple-conductor-reset-idle.test.ts — reset-aware idle for `loop --watch`.
 *
 *  [W1] simpleConductorNextWaitMs: pure wait computation (injected now).
 *  [W2] runSimpleConductorWatch parks until the earliest reset instead of
 *       hot-ticking on the interval, and returns to the interval once work
 *       dispatches again.
 *  [W3] The park stays interruptible: abort signal and kill switch end it.
 *
 * No real IO: every tick, sleep, clock and kill-switch read is injected.
 */

import { describe, it, expect } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  SIMPLE_CONDUCTOR_DEFAULT_INTERVAL_MS,
  SIMPLE_CONDUCTOR_MAX_RESET_WAIT_MS,
  resolveSimpleConductorIntervalMs,
  runSimpleConductorWatch,
  simpleConductorNextWaitMs,
  type SimpleConductorResult,
} from '../src/core/simple-conductor.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MIN = 60_000;
const INTERVAL = 5 * MIN;

function tick(overrides: Partial<SimpleConductorResult> = {}): SimpleConductorResult {
  return {
    tasksAttempted: 0,
    proposalsFiled: 0,
    proposalsRecovered: 0,
    merged: 0,
    errors: [],
    killSwitchTripped: false,
    ...overrides,
  };
}

function deferredAt(...resets: Array<number | undefined>): SimpleConductorResult['deferred'] {
  return resets.map((ms, i) => ({
    taskId: `t${i}`,
    engine: 'claude',
    reason: 'resource-pause: no candidate engine has capacity',
    ...(ms === undefined ? {} : { earliestResetAt: new Date(ms).toISOString() }),
  }));
}

const cfg = {} as AshlrConfig;

describe('[W1] simpleConductorNextWaitMs', () => {
  it('keeps the interval when nothing was deferred', () => {
    expect(simpleConductorNextWaitMs(tick(), INTERVAL, NOW)).toBe(INTERVAL);
    expect(simpleConductorNextWaitMs(tick({ deferred: [] }), INTERVAL, NOW)).toBe(INTERVAL);
  });

  it('keeps the interval when the tick dispatched something', () => {
    const r = tick({ tasksAttempted: 1, deferred: deferredAt(NOW + 10 * MIN) });
    expect(simpleConductorNextWaitMs(r, INTERVAL, NOW)).toBe(INTERVAL);
  });

  it('keeps the interval when no reset is known, or it is invalid or past', () => {
    expect(simpleConductorNextWaitMs(tick({ deferred: deferredAt(undefined) }), INTERVAL, NOW)).toBe(INTERVAL);
    expect(simpleConductorNextWaitMs(tick({ deferred: deferredAt(NOW - MIN) }), INTERVAL, NOW)).toBe(INTERVAL);
    expect(simpleConductorNextWaitMs(tick({ deferred: deferredAt(NOW) }), INTERVAL, NOW)).toBe(INTERVAL);
    const garbage = tick({ deferred: [{ taskId: 'x', engine: 'claude', reason: 'r', earliestResetAt: 'not-a-date' }] });
    expect(simpleConductorNextWaitMs(garbage, INTERVAL, NOW)).toBe(INTERVAL);
  });

  it('waits until the earliest future reset across deferred tasks', () => {
    const r = tick({ deferred: deferredAt(NOW + 12 * MIN, undefined, NOW + 9 * MIN) });
    expect(simpleConductorNextWaitMs(r, INTERVAL, NOW)).toBe(9 * MIN);
  });

  it('a reset that has already passed for any deferred task keeps the interval', () => {
    // That task's engine may already have reopened, so the next tick is not delayed.
    const r = tick({ deferred: deferredAt(NOW + 12 * MIN, NOW - MIN) });
    expect(simpleConductorNextWaitMs(r, INTERVAL, NOW)).toBe(INTERVAL);
  });

  it('never waits less than the interval', () => {
    const r = tick({ deferred: deferredAt(NOW + 30_000) });
    expect(simpleConductorNextWaitMs(r, INTERVAL, NOW)).toBe(INTERVAL);
  });

  it('never waits longer than the 15 minute cap', () => {
    expect(SIMPLE_CONDUCTOR_MAX_RESET_WAIT_MS).toBe(15 * MIN);
    const r = tick({ deferred: deferredAt(NOW + 4 * 60 * MIN) });
    expect(simpleConductorNextWaitMs(r, INTERVAL, NOW)).toBe(15 * MIN);
  });

  it('an interval longer than the cap still wins', () => {
    const r = tick({ deferred: deferredAt(NOW + 4 * 60 * MIN) });
    expect(simpleConductorNextWaitMs(r, 30 * MIN, NOW)).toBe(30 * MIN);
  });

  it('falls back to the default interval for a nonsense interval', () => {
    expect(simpleConductorNextWaitMs(tick(), 0, NOW)).toBe(SIMPLE_CONDUCTOR_DEFAULT_INTERVAL_MS);
    expect(simpleConductorNextWaitMs(tick(), Number.NaN, NOW)).toBe(SIMPLE_CONDUCTOR_DEFAULT_INTERVAL_MS);
  });

  it('resolves the interval from cfg.daemon.intervalMs', () => {
    expect(resolveSimpleConductorIntervalMs(cfg)).toBe(SIMPLE_CONDUCTOR_DEFAULT_INTERVAL_MS);
    expect(resolveSimpleConductorIntervalMs({ daemon: { intervalMs: 2 * MIN } } as AshlrConfig)).toBe(2 * MIN);
    expect(resolveSimpleConductorIntervalMs({ daemon: { intervalMs: -1 } } as AshlrConfig))
      .toBe(SIMPLE_CONDUCTOR_DEFAULT_INTERVAL_MS);
  });
});

describe('[W2] runSimpleConductorWatch waits for the reset', () => {
  it('parks until the reset instead of hot-ticking, then resumes the interval', async () => {
    const controller = new AbortController();
    let clock = NOW;
    const reset = NOW + 11 * MIN;
    const ticks: SimpleConductorResult[] = [
      tick({ deferred: deferredAt(reset) }),
      tick({ tasksAttempted: 1 }),
      tick(),
    ];
    let tickCount = 0;
    const sleeps: number[] = [];
    const onTickWaits: Array<number | null> = [];

    const last = await runSimpleConductorWatch({ daemon: { intervalMs: INTERVAL } } as AshlrConfig, {
      dryRun: false,
      allowCloud: false,
      signal: controller.signal,
      handleSignals: false,
      killSwitchOn: () => false,
      now: () => clock,
      runTick: async (_cfg, opts) => {
        expect(opts.once).toBe(false);
        const r = ticks[tickCount++]!;
        if (tickCount === ticks.length) controller.abort();
        return r;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        return true;
      },
      onTick: (_r, wait) => onTickWaits.push(wait),
    });

    expect(tickCount).toBe(3);
    // First park waits the full 11 minutes to the reset, not the 5 minute interval.
    expect(sleeps).toEqual([11 * MIN, INTERVAL]);
    expect(onTickWaits).toEqual([11 * MIN, INTERVAL, null]);
    expect(last).toBe(ticks[2]);
  });

  it('stops without parking when a tick is refused or the kill switch trips', async () => {
    const sleeps: number[] = [];
    const base = {
      dryRun: false,
      allowCloud: false,
      handleSignals: false,
      killSwitchOn: () => false,
      sleep: async (ms: number) => { sleeps.push(ms); return true; },
    };
    const refused = await runSimpleConductorWatch(cfg, { ...base, runTick: async () => tick({ activationRefused: true }) });
    expect(refused.activationRefused).toBe(true);
    const killed = await runSimpleConductorWatch(cfg, { ...base, runTick: async () => tick({ killSwitchTripped: true }) });
    expect(killed.killSwitchTripped).toBe(true);
    expect(sleeps).toEqual([]);
  });
});

describe('[W3] the park stays interruptible', () => {
  it('an abort ends a long reset park at once', async () => {
    const controller = new AbortController();
    let ticks = 0;
    const started = Date.now();
    const done = runSimpleConductorWatch(cfg, {
      dryRun: false,
      allowCloud: false,
      signal: controller.signal,
      handleSignals: false,
      killSwitchOn: () => false,
      runTick: async () => {
        ticks += 1;
        return tick({ deferred: deferredAt(Date.now() + 14 * MIN) });
      },
    });
    setTimeout(() => controller.abort(), 20);
    await done;
    expect(ticks).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the kill switch ends a long reset park', async () => {
    let killed = false;
    let ticks = 0;
    const started = Date.now();
    const done = runSimpleConductorWatch(cfg, {
      dryRun: false,
      allowCloud: false,
      handleSignals: false,
      killSwitchOn: () => killed,
      runTick: async () => {
        ticks += 1;
        return tick({ deferred: deferredAt(Date.now() + 14 * MIN) });
      },
    });
    setTimeout(() => { killed = true; }, 20);
    await done;
    expect(ticks).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('SIGINT ends the park when signal handling is on, and the handler is removed after', async () => {
    const existing = new Set(process.listeners('SIGINT'));
    const before = existing.size;
    let ticks = 0;
    const done = runSimpleConductorWatch(cfg, {
      dryRun: false,
      allowCloud: false,
      killSwitchOn: () => false,
      runTick: async () => {
        ticks += 1;
        return tick({ deferred: deferredAt(Date.now() + 14 * MIN) });
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    // Invoke only the watch loop's handler: emitting a real SIGINT would also
    // reach the test runner's own listeners.
    const added = process.listeners('SIGINT').filter((l) => !existing.has(l));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    await done;
    expect(ticks).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
