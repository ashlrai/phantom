/**
 * RQ-PHX-SELFLOOPPREABORT02SOMD1 — graceful backpressure: a supervisor
 * cancelling a loop before it begins must prevent any worker-launching tick.
 * runSelfLoop now checks cancellation before the first tick as well as
 * subsequent ticks, preserving immediate first execution when not cancelled.
 * Returns a truthful interrupted summary with zero ticks, failures and busy
 * when pre-aborted.  Does not invoke tick, observer or sleep.
 *
 * Cancellation semantics for a pass already running are preserved: the
 * pass is awaited, counted, and no next pass is admitted.
 *
 * Clocks, ticks and sleeps are faked; no real processes or sleeps.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runSelfLoop, type SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps, sleep };
};

describe('fleet self-loop pre-abort', () => {

  it('a real AbortController aborted before runSelfLoop produces no tick calls', async () => {
    const ac = new AbortController();
    ac.abort();
    let tickCalled = false;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      tickCalled = true;
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const summary = await runSelfLoop({
      tick,
      durationMs: 60_000,
      intervalMs: 1_000,
      signal: ac.signal,
    });
    expect(tickCalled).toBe(false);
    expect(summary.ticks).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.busy).toBe(0);
    expect(summary.termination).toBe('interrupted');
    expect(summary.lastReport).toBe(null);
  });

  it('pre-abort summary: elapsedMs is near-zero, no sleep seam invocation', async () => {
    let sleepCalled = false;
    const ac = new AbortController();
    ac.abort();
    const summary = await runSelfLoop({
      tick: async () => ({ exitCode: 0, report: null }),
      durationMs: 60_000,
      intervalMs: 1_000,
      signal: ac.signal,
      sleep: async (ms: number) => { sleepCalled = true; },
    });
    expect(sleepCalled).toBe(false);
    expect(summary.elapsedMs).toBeLessThan(10);
    expect(summary.ticks).toBe(0);
    expect(summary.failures).toBe(0);
    expect(summary.busy).toBe(0);
    expect(summary.termination).toBe('interrupted');
    expect(summary.lastReport).toBe(null);
  });

  it('pre-abort does not invoke an onPass observer', async () => {
    let observerCalled = false;
    const ac = new AbortController();
    ac.abort();
    const summary = await runSelfLoop({
      tick: async () => ({ exitCode: 0, report: null }),
      durationMs: 60_000,
      intervalMs: 1_000,
      signal: ac.signal,
      onPass: () => { observerCalled = true; },
    });
    expect(observerCalled).toBe(false);
    expect(summary.ticks).toBe(0);
  });

  it('a deferred tick that completes past the deadline is still counted (abort during sleep → interrupted)', async () => {
    let resolveSecond!: (outcome: SelfLoopTickOutcome) => void;
    let resolveSleep!: () => void;
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      new Promise<SelfLoopTickOutcome>((res) => { resolveSecond = res; });
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((res) => { resolveSleep = res; });
    const ac = new AbortController();
    // Let the first tick finish, then abort during the sleep.
    const promise = runSelfLoop({
      tick,
      durationMs: 5_000,
      intervalMs: 1_000,
      signal: ac.signal,
      sleep,
      now: () => 0,
    });
    // First tick starts
    resolveSecond({ exitCode: 0, report: { state: 'ran' } });
    // Wait for the tick to complete, then abort during the sleep
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    resolveSleep!();
    const summary = await promise;
    expect(summary.ticks).toBe(1);
    expect(summary.failures).toBe(0);
    expect(summary.termination).toBe('interrupted');
    expect(summary.lastReport).toEqual({ state: 'ran' });
  });

  it('normal first tick runs immediately when signal is not aborted', async () => {
    const clock = fakeClock();
    let tickCalled = false;
    const summary = await runSelfLoop({
      tick: async (): Promise<SelfLoopTickOutcome> => {
        tickCalled = true;
        return { exitCode: 0, report: { state: 'ran' } };
      },
      durationMs: 500,
      intervalMs: 1_000,
      signal: new AbortController().signal,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(tickCalled).toBe(true);
    expect(summary.ticks).toBe(1);
    expect(summary.failures).toBe(0);
    expect(summary.busy).toBe(0);
    expect(summary.termination).toBe('duration');
    expect(summary.lastReport).toEqual({ state: 'ran' });
  });

  it('max-ticks behavior is unchanged: first tick runs, then stops at bound', async () => {
    const clock = fakeClock();
    const summary = await runSelfLoop({
      tick: async (): Promise<SelfLoopTickOutcome> =>
        ({ exitCode: 0, report: { state: 'ran' } }),
      durationMs: 300_000,
      intervalMs: 50_000,
      maxTicks: 2,
      signal: new AbortController().signal,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(summary.ticks).toBe(2);
    expect(summary.termination).toBe('max-ticks');
    expect(summary.maxTicks).toBe(2);
  });

  it('deadline behavior is unchanged: runs passes until deadline, then stops', async () => {
    const clock = fakeClock();
    const summary = await runSelfLoop({
      tick: async (): Promise<SelfLoopTickOutcome> =>
        ({ exitCode: 0, report: { state: 'ran' } }),
      durationMs: 2_500,
      intervalMs: 1_000,
      signal: new AbortController().signal,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(summary.ticks).toBe(3); // 0, 1000, 2000 → 3 passes
    expect(summary.termination).toBe('duration');
    expect(clock.sleeps).toEqual([1_000, 1_000, 500]);
  });

  it('pre-aborted signal with max-ticks: no ticks, no sleep, interrupted', async () => {
    const ac = new AbortController();
    ac.abort();
    let tickCalled = false;
    const summary = await runSelfLoop({
      tick: async (): Promise<SelfLoopTickOutcome> => {
        tickCalled = true;
        return { exitCode: 0, report: { state: 'ran' } };
      },
      durationMs: 60_000,
      intervalMs: 1_000,
      maxTicks: 5,
      signal: ac.signal,
    });
    expect(tickCalled).toBe(false);
    expect(summary.ticks).toBe(0);
    expect(summary.termination).toBe('interrupted');
    expect(summary.lastReport).toBe(null);
  });
});
