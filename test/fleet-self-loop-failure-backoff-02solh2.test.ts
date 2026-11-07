import { describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import { runSelfLoop, SELF_LOOP_MAX_DURATION_MS, type SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

const fail: SelfLoopTickOutcome = { exitCode: 1, report: { state: 'ran' } };
const pass: SelfLoopTickOutcome = { exitCode: 0, report: { state: 'ran' } };
const busy: SelfLoopTickOutcome = { exitCode: 1, report: { state: 'busy' } };

function harness(outcomes: SelfLoopTickOutcome[]) {
  let time = 0, index = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    advance: (ms: number) => { time += ms; },
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    tick: async () => outcomes[Math.min(index++, outcomes.length - 1)]!,
    sleeps,
  };
}

describe('self-loop failure backoff', () => {
  it('doubles failures, resets on recovery, and caps the remaining budget', async () => {
    const h = harness([fail, fail, pass, fail]);
    const events: unknown[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 10_500, intervalMs: 1000,
      failureBackoffMaxMs: 8000, onPass: event => { events.push(event); } });
    expect(h.sleeps).toEqual([2000, 4000, 1000, 2000, 1500]);
    expect(events).toMatchObject([
      { consecutiveFailures: 1, nextDelayMs: 2000 },
      { consecutiveFailures: 2, nextDelayMs: 4000 },
      { consecutiveFailures: 0, nextDelayMs: 1000 },
      { consecutiveFailures: 1, nextDelayMs: 2000 },
      { consecutiveFailures: 2, nextDelayMs: 1500 },
    ]);
    expect(summary).toMatchObject({ ticks: 5, failures: 4, elapsedMs: 10_500 });
  });

  it('resets on busy even when busy has a failing exit code', async () => {
    const h = harness([fail, busy, fail]);
    const streaks: number[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 5000, intervalMs: 1000,
      failureBackoffMaxMs: 8000, onPass: event => { streaks.push(event.consecutiveFailures!); } });
    expect(h.sleeps).toEqual([2000, 1000, 2000]);
    expect(streaks).toEqual([1, 0, 1]);
    expect(summary).toMatchObject({ failures: 3, busy: 1 });
  });

  it('saturates at the maximum across many failures', async () => {
    const h = harness([fail]);
    await runSelfLoop({ ...h, durationMs: 103_000, intervalMs: 1000, failureBackoffMaxMs: 3000 });
    expect(h.sleeps).toEqual([2000, ...Array<number>(33).fill(3000), 2000]);
    expect(h.sleeps.every(Number.isFinite)).toBe(true);
  });

  it('keeps default event and summary shapes and fixed timing', async () => {
    const h = harness([fail]);
    const events: unknown[] = [];
    const summary = await runSelfLoop({ ...h, durationMs: 2500, intervalMs: 1000,
      onPass: event => { events.push(event); } });
    expect(h.sleeps).toEqual([1000, 1000, 500]);
    expect(events[0]).toEqual({ pass: 1, exitCode: 1, state: 'ran', report: fail.report });
    expect(Object.keys(summary).sort()).toEqual(['busy', 'durationMs', 'elapsedMs', 'endedAt', 'failures',
      'intervalMs', 'lastReport', 'startedAt', 'termination', 'ticks', 'v']);
  });

  it('does not sleep after an in-flight pass crosses the deadline or is cancelled', async () => {
    for (const cancel of [false, true]) {
      const h = harness([fail]);
      const controller = new AbortController();
      const summary = await runSelfLoop({ ...h, durationMs: 1000, intervalMs: 1000,
        failureBackoffMaxMs: 4000, signal: controller.signal,
        tick: async () => { if (cancel) controller.abort(); else h.advance(1500); return fail; } });
      expect(h.sleeps).toEqual([]);
      expect(summary).toMatchObject({ ticks: 1, termination: cancel ? 'interrupted' : 'duration' });
    }
  });

  it('refuses invalid bounds and duplicate options before ticking', async () => {
    for (const args of [
      ['--failure-backoff-max-ms', '999'], ['--failure-backoff-max-ms', String(SELF_LOOP_MAX_DURATION_MS + 1)],
      ['--failure-backoff-max-ms', 'no'], ['--failure-backoff-max-ms'],
      ['--failure-backoff-max-ms', '1000', '--failure-backoff-max-ms', '2000'],
      ['--failure-backoff-max-ms', '1000', '--interval-ms', '2000'],
    ]) {
      let ticks = 0;
      const code = await cmdFleetSelfLoop(['--duration-ms', '1000', '--interval-ms', '1000', ...args], {
        tick: async () => { ticks++; return pass; }, error: () => {}, onSignal: () => () => {},
      });
      expect(code).toBe(2);
      expect(ticks).toBe(0);
    }
    expect(await cmdFleetSelfLoop(['--duration-ms', '1000', '--failure-backoff-max-ms', '1000'], {
      tick: async () => { throw new Error('must not tick'); }, error: () => {},
    })).toBe(2);
  });

  it('emits opt-in stream fields and leaves default stream records unchanged', async () => {
    for (const enabled of [false, true]) {
      const h = harness([fail, pass]);
      const lines: string[] = [];
      const code = await cmdFleetSelfLoop(['--stream', '--duration-ms', '3000', '--interval-ms', '1000',
        ...(enabled ? ['--failure-backoff-max-ms', '4000'] : [])], {
        ...h, output: line => { lines.push(line); }, error: () => {}, onSignal: () => () => {},
      });
      expect(code).toBe(1);
      const records = lines.map(line => JSON.parse(line));
      expect(records[0]).toMatchObject(enabled ? { consecutiveFailures: 1, nextDelayMs: 2000 } : { pass: 1 });
      if (enabled) expect(records[1]).toMatchObject({ consecutiveFailures: 0, nextDelayMs: 1000 });
      else expect(records[0]).not.toHaveProperty('consecutiveFailures');
      expect(records.at(-1)).not.toHaveProperty('consecutiveFailures');
    }
  });
});
