/**
 * RQ-PHX-SELFLOOPDEADLINESLEEP02SOLG2 — the inter-pass sleep is capped to the
 * budget left before the deadline, so a short window ends at its deadline even
 * when the interval is much longer. Clocks, ticks and sleeps are faked; no
 * real timer, provider or machine state is touched.
 */
import { describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import { runSelfLoop, type SelfLoopPassEvent, type SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

/** Fake clock; the sleep seam records each request and advances time by it. */
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps, sleep };
};

const okTick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'ran' } });

describe('fleet self-loop sleep budget', () => {
  it('a 1s window with a 60s interval sleeps only the remaining 1s and runs exactly one tick', async () => {
    const clock = fakeClock();
    let ticks = 0;
    const summary = await runSelfLoop({
      durationMs: 1000, intervalMs: 60_000, now: clock.now, sleep: clock.sleep,
      tick: async () => { ticks++; return okTick(); },
    });
    expect(ticks).toBe(1);
    expect(clock.sleeps).toEqual([1000]);
    expect(summary).toMatchObject({ ticks: 1, elapsedMs: 1000, termination: 'duration' });
  });

  it('a tick consuming part of its budget shortens the following sleep to the rest', async () => {
    const clock = fakeClock();
    const summary = await runSelfLoop({
      durationMs: 1000, intervalMs: 60_000, now: clock.now, sleep: clock.sleep,
      tick: async () => { clock.advance(300); return okTick(); },
    });
    expect(clock.sleeps).toEqual([700]);
    expect(summary).toMatchObject({ ticks: 1, elapsedMs: 1000, termination: 'duration' });
  });

  it('a tick finishing past the deadline causes no sleep and no further tick', async () => {
    const clock = fakeClock();
    let ticks = 0;
    const summary = await runSelfLoop({
      durationMs: 1000, intervalMs: 60_000, now: clock.now, sleep: clock.sleep,
      tick: async () => { ticks++; clock.advance(1500); return okTick(); },
    });
    expect(ticks).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(summary).toMatchObject({ ticks: 1, elapsedMs: 1500, termination: 'duration' });
  });

  it('a multi-pass window keeps the full interval between passes and the last one is capped', async () => {
    const clock = fakeClock();
    const startedAt: number[] = [];
    const tick = async (): Promise<SelfLoopTickOutcome> => { startedAt.push(clock.now()); return okTick(); };
    const summary = await runSelfLoop({
      durationMs: 2500, intervalMs: 1000, now: clock.now, sleep: clock.sleep, tick,
    });
    expect(startedAt).toEqual([0, 1000, 2000]);
    expect(clock.sleeps).toEqual([1000, 1000, 500]);
    expect(summary).toMatchObject({ ticks: 3, elapsedMs: 2500, termination: 'duration' });
  });

  it('emits each observer event once, in order, and keeps only lastReport', async () => {
    const clock = fakeClock();
    let n = 0;
    const events: SelfLoopPassEvent[] = [];
    const tick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'ran', seq: ++n } });
    const summary = await runSelfLoop({
      durationMs: 5000, intervalMs: 1000, now: clock.now, sleep: clock.sleep, tick,
      onPass: (event) => { events.push(event); },
    });
    expect(events.map((e) => e.pass)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.exitCode === 0 && e.state === 'ran')).toBe(true);
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(summary.lastReport).toEqual({ state: 'ran', seq: 5 });
    expect(Object.keys(summary).sort()).toEqual([
      'busy', 'durationMs', 'elapsedMs', 'endedAt', 'failures', 'intervalMs',
      'lastReport', 'startedAt', 'termination', 'ticks', 'v',
    ]);
  });

  it('a signal during the capped sleep still interrupts admission', async () => {
    const controller = new AbortController();
    let ticks = 0;
    const sleepSeen: number[] = [];
    const summary = await runSelfLoop({
      durationMs: 60_000, intervalMs: 60_000, signal: controller.signal, now: () => 0,
      tick: async () => { ticks++; return okTick(); },
      sleep: (ms, signal) => new Promise<void>((_resolve, reject) => {
        sleepSeen.push(ms);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        controller.abort();
      }),
    });
    expect(sleepSeen).toEqual([60_000]);
    expect(ticks).toBe(1);
    expect(summary).toMatchObject({ ticks: 1, termination: 'interrupted' });
  });

  it('the exported CLI runs one short window with a long interval and prints one summary with exit 0', async () => {
    const clock = fakeClock();
    let ticks = 0;
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdFleetSelfLoop(['--json', '--duration-ms', '1000'], {
      tick: async () => { ticks++; return okTick(); },
      now: clock.now, sleep: clock.sleep,
      output: (text) => out.push(text), error: (text) => err.push(text),
      onSignal: () => () => {},
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(ticks).toBe(1);
    expect(clock.sleeps).toEqual([1000]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      ticks: 1, failures: 0, busy: 0, termination: 'duration',
      durationMs: 1000, intervalMs: 60_000, elapsedMs: 1000,
    });
  });

  it('the exported CLI short window exits 1 when its single pass fails', async () => {
    const clock = fakeClock();
    const out: string[] = [];
    const code = await cmdFleetSelfLoop(['--json', '--duration-ms', '1000'], {
      tick: async () => ({ exitCode: 1, report: null }),
      now: clock.now, sleep: clock.sleep,
      output: (text) => out.push(text), error: () => {},
      onSignal: () => () => {},
    });
    expect(code).toBe(1);
    expect(clock.sleeps).toEqual([1000]);
    expect(JSON.parse(out[0]!)).toMatchObject({ ticks: 1, failures: 1, termination: 'duration' });
  });
});
