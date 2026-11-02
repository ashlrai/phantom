/**
 * RQ-PHX-SELFLOOPBUSYBACKOFF02SOLL2 — opt-in busy backoff. A pass reporting
 * state 'busy' stretches the wait per consecutive busy pass (any exit code),
 * independently of the failure streak. Clocks, ticks and sleeps are faked; no
 * real timer, lock or runs directory is touched.
 */
import { describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import {
  runSelfLoop,
  SELF_LOOP_MAX_DURATION_MS,
  type SelfLoopPassEvent,
  type SelfLoopTickOutcome,
} from '../src/core/fleet/self-loop.js';

const ok: SelfLoopTickOutcome = { exitCode: 0, report: { state: 'ran' } };
const fail: SelfLoopTickOutcome = { exitCode: 1, report: { state: 'ran' } };
const busy: SelfLoopTickOutcome = { exitCode: 0, report: { state: 'busy' } };
const busyFailing: SelfLoopTickOutcome = { exitCode: 1, report: { state: 'busy' } };

/** Fake clock; the script is consumed in order, then its last outcome repeats. */
function harness(script: SelfLoopTickOutcome[]) {
  let time = 0, index = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    tick: async () => script[Math.min(index++, script.length - 1)]!,
  };
}

describe('fleet self-loop busy backoff', () => {
  it('doubles per consecutive busy pass and returns to the base interval on the next non-busy pass', async () => {
    const h = harness([busy, busy, ok]);
    const events: SelfLoopPassEvent[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 7000, intervalMs: 1000,
      busyBackoffMaxMs: 8000, onPass: event => { events.push(event); } });
    expect(h.sleeps).toEqual([2000, 4000, 1000]);
    expect(events).toMatchObject([
      { consecutiveBusy: 1, nextDelayMs: 2000 },
      { consecutiveBusy: 2, nextDelayMs: 4000 },
      { consecutiveBusy: 0, nextDelayMs: 1000 },
    ]);
    expect(summary).toMatchObject({ ticks: 3, busy: 2, failures: 0, elapsedMs: 7000, termination: 'duration' });
  });

  it('caps the busy delay at busyBackoffMaxMs across many busy passes', async () => {
    const h = harness([busy]);
    const summary = await runSelfLoop({ ...h, durationMs: 11_000, intervalMs: 1000, busyBackoffMaxMs: 3000 });
    expect(h.sleeps).toEqual([2000, 3000, 3000, 3000]);
    expect(summary).toMatchObject({ ticks: 4, busy: 4, elapsedMs: 11_000 });
  });

  it('clamps the busy sleep to the budget remaining before the deadline', async () => {
    const h = harness([busy]);
    const summary = await runSelfLoop({ ...h, durationMs: 5000, intervalMs: 1000, busyBackoffMaxMs: 8000 });
    expect(h.sleeps).toEqual([2000, 3000]);
    expect(summary).toMatchObject({ ticks: 2, elapsedMs: 5000, termination: 'duration' });
  });

  it('backs off on busy regardless of exit code and still counts failures as before', async () => {
    const h = harness([busyFailing, busyFailing, ok]);
    const summary = await runSelfLoop({ ...h, durationMs: 7000, intervalMs: 1000, busyBackoffMaxMs: 8000 });
    expect(h.sleeps).toEqual([2000, 4000, 1000]);
    expect(summary).toMatchObject({ ticks: 3, busy: 2, failures: 2 });
  });

  it('keeps a failure streak independent of a preceding busy streak when both are enabled', async () => {
    const h = harness([busy, busy, fail, fail]);
    const events: SelfLoopPassEvent[] = [];
    await runSelfLoop({ ...h, durationMs: 12_000, intervalMs: 1000,
      failureBackoffMaxMs: 8000, busyBackoffMaxMs: 8000, onPass: event => { events.push(event); } });
    // The failure after two busy passes starts at 2x, not 8x: busy never feeds the failure streak.
    expect(h.sleeps).toEqual([2000, 4000, 2000, 4000]);
    expect(events).toMatchObject([
      { consecutiveFailures: 0, consecutiveBusy: 1, nextDelayMs: 2000 },
      { consecutiveFailures: 0, consecutiveBusy: 2, nextDelayMs: 4000 },
      { consecutiveFailures: 1, consecutiveBusy: 0, nextDelayMs: 2000 },
      { consecutiveFailures: 2, consecutiveBusy: 0, nextDelayMs: 4000 },
    ]);
  });

  it('keeps a busy streak independent of a preceding failure streak when both are enabled', async () => {
    const h = harness([fail, fail, busy, busy]);
    const events: SelfLoopPassEvent[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 12_000, intervalMs: 1000,
      failureBackoffMaxMs: 8000, busyBackoffMaxMs: 8000, onPass: event => { events.push(event); } });
    // The busy after two failures starts at 2x, not 8x: failure never feeds the busy streak.
    expect(h.sleeps).toEqual([2000, 4000, 2000, 4000]);
    expect(events).toMatchObject([
      { consecutiveFailures: 1, consecutiveBusy: 0, nextDelayMs: 2000 },
      { consecutiveFailures: 2, consecutiveBusy: 0, nextDelayMs: 4000 },
      { consecutiveFailures: 0, consecutiveBusy: 1, nextDelayMs: 2000 },
      { consecutiveFailures: 0, consecutiveBusy: 2, nextDelayMs: 4000 },
    ]);
    expect(summary).toMatchObject({ ticks: 4, failures: 2, busy: 2 });
  });

  it('ends at once when aborted during a busy wait and never runs another pass', async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let ticks = 0;
    const summary = await runSelfLoop({
      durationMs: 60_000, intervalMs: 1000, busyBackoffMaxMs: 8000, signal: controller.signal,
      now: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); controller.abort(); throw new Error('aborted'); },
      tick: async () => { ticks++; return busy; },
    });
    expect(sleeps).toEqual([2000]);
    expect(ticks).toBe(1);
    expect(summary).toMatchObject({ ticks: 1, busy: 1, termination: 'interrupted' });
  });

  it('keeps default event and schedule when the option is omitted', async () => {
    const h = harness([busy, busy, ok]);
    const events: unknown[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 3000, intervalMs: 1000,
      onPass: event => { events.push(event); } });
    expect(h.sleeps).toEqual([1000, 1000, 1000]);
    expect(events[0]).toEqual({ pass: 1, exitCode: 0, state: 'busy', report: busy.report });
    expect(Object.keys(summary).sort()).toEqual(['busy', 'durationMs', 'elapsedMs', 'endedAt', 'failures',
      'intervalMs', 'lastReport', 'startedAt', 'termination', 'ticks', 'v']);
  });
});

describe('fleet self-loop busy backoff CLI forwarding', () => {
  it('forwards the cap and streams consecutiveBusy and nextDelayMs per pass', async () => {
    const h = harness([busy, busy, ok]);
    const lines: string[] = [];
    const code = await cmdFleetSelfLoop(
      ['--stream', '--duration-ms', '7000', '--interval-ms', '1000', '--busy-backoff-max-ms', '8000'], {
        now: h.now, sleep: h.sleep, tick: h.tick,
        output: line => { lines.push(line); }, error: () => {}, onSignal: () => () => {},
      });
    expect(code).toBe(0);
    expect(h.sleeps).toEqual([2000, 4000, 1000]);
    const records = lines.map(line => JSON.parse(line));
    expect(records.slice(0, 3)).toMatchObject([
      { v: 1, record: 'pass', consecutiveBusy: 1, nextDelayMs: 2000 },
      { v: 1, record: 'pass', consecutiveBusy: 2, nextDelayMs: 4000 },
      { v: 1, record: 'pass', consecutiveBusy: 0, nextDelayMs: 1000 },
    ]);
    expect(records[0]).not.toHaveProperty('consecutiveFailures');
    expect(records.at(-1)).toMatchObject({ v: 1, record: 'summary', ticks: 3, busy: 2, termination: 'duration' });
  });

  it('leaves default stream records free of busy fields when the option is omitted', async () => {
    const h = harness([busy]);
    const lines: string[] = [];
    await cmdFleetSelfLoop(['--stream', '--duration-ms', '2000', '--interval-ms', '1000'], {
      now: h.now, sleep: h.sleep, tick: h.tick,
      output: line => { lines.push(line); }, error: () => {}, onSignal: () => () => {},
    });
    const records = lines.map(line => JSON.parse(line));
    expect(records[0]).toMatchObject({ record: 'pass', pass: 1 });
    expect(records[0]).not.toHaveProperty('consecutiveBusy');
    expect(records[0]).not.toHaveProperty('nextDelayMs');
    expect(h.sleeps).toEqual([1000, 1000]);
  });

  it('accepts both backoff options together', async () => {
    const h = harness([ok]);
    const code = await cmdFleetSelfLoop(['--duration-ms', '1000', '--interval-ms', '1000',
      '--failure-backoff-max-ms', '4000', '--busy-backoff-max-ms', '4000'], {
      now: h.now, sleep: h.sleep, tick: h.tick, output: () => {}, error: () => {}, onSignal: () => () => {},
    });
    expect(code).toBe(0);
  });

  it('refuses invalid or duplicate busy bounds before any tick', async () => {
    for (const args of [
      ['--busy-backoff-max-ms', '999'], ['--busy-backoff-max-ms', String(SELF_LOOP_MAX_DURATION_MS + 1)],
      ['--busy-backoff-max-ms', 'no'], ['--busy-backoff-max-ms', '-5'], ['--busy-backoff-max-ms', '1.5e3'],
      ['--busy-backoff-max-ms'],
      ['--busy-backoff-max-ms', '2000', '--busy-backoff-max-ms', '3000'],
      ['--busy-backoff-max-ms', '2000', '--busy-backoff-max-ms', '2000'],
      ['--busy-backoff-max-ms', '1000', '--interval-ms', '2000'],
    ]) {
      let ticks = 0;
      const code = await cmdFleetSelfLoop(['--duration-ms', '1000', '--interval-ms', '1000', ...args], {
        tick: async () => { ticks++; return ok; }, output: () => {}, error: () => {}, onSignal: () => () => {},
      });
      expect(code, args.join(' ')).toBe(2);
      expect(ticks, args.join(' ')).toBe(0);
    }
    // Without --interval-ms the effective interval is the 60s default, so a 1s cap is below it.
    expect(await cmdFleetSelfLoop(['--duration-ms', '1000', '--busy-backoff-max-ms', '1000'], {
      tick: async () => { throw new Error('must not tick'); }, output: () => {}, error: () => {},
    })).toBe(2);
  });
});
