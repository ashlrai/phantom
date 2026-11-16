/** runCosLoop + `ashlr fleet cos-loop` (RQ-PHX-COSLOOPVERB12).
 *
 * Every test runs on a fake clock: the work seam is a scripted fake (no
 * queue, no spawn) and the sleep seam is a fake that advances the clock or
 * aborts (no real timers). Nothing touches ~/.ashlr-runs.
 */
import { describe, expect, it } from 'vitest';
import { runCosLoop } from '../src/core/cos/loop.js';
import { cmdFleetCosLoop } from '../src/cli/fleet-cos-loop.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { CosWorkOptions, CosWorkResult } from '../src/core/cos/worker.js';

const idle: CosWorkResult = { outcome: 'idle' };
const drafted = (id = 'cos-aaaa'): CosWorkResult => ({ outcome: 'drafted', id, provider: 'fake' });
const blocked = (reason: string, id = 'cos-bbbb'): CosWorkResult => ({ outcome: 'blocked', id, reason });
const paused: CosWorkResult = { outcome: 'paused' };

interface ScriptedWork {
  work: (opts: CosWorkOptions) => Promise<CosWorkResult>;
  atCalls: number[];
  lastOpts: () => CosWorkOptions | undefined;
}

/** A work seam that replays `seq`, repeating the last entry forever. 'throw' throws. */
function scriptedWork(seq: readonly (CosWorkResult | 'throw')[], now: () => number): ScriptedWork {
  let i = 0;
  const atCalls: number[] = [];
  const optsSeen: CosWorkOptions[] = [];
  return {
    atCalls,
    lastOpts: () => optsSeen.at(-1),
    work: async (opts: CosWorkOptions): Promise<CosWorkResult> => {
      optsSeen.push(opts);
      atCalls.push(now());
      const next = seq[Math.min(i++, seq.length - 1)];
      if (next === 'throw') throw new Error('pass exploded');
      return next;
    },
  };
}

interface FakeSleep {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  calls: number[];
}

/** A sleep seam that advances the fake clock and rejects only if already aborted. */
function fakeSleep(tick: (ms: number) => void): FakeSleep {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number, signal: AbortSignal) => {
      calls.push(ms);
      tick(ms);
      if (signal.aborted) throw new Error('aborted');
    },
  };
}

function clock(start = 0): { now: () => number; tick: (ms: number) => void } {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe('runCosLoop', () => {
  it('runs drafted passes back-to-back with no wait to drain the backlog', async () => {
    const c = clock();
    const work = scriptedWork([drafted('cos-1'), drafted('cos-2'), idle], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 12_000, intervalMs: 5_000, work: work.work, sleep: sleep.sleep, now: c.now,
    });
    // The first two drafted passes and the first idle pass all ran at t=0:
    // no sleep intervened while the backlog was draining.
    expect(work.atCalls.slice(0, 3)).toEqual([0, 0, 0]);
    expect(sleep.calls).toEqual([5_000, 5_000, 2_000]);
    expect(summary).toMatchObject({
      v: 1, passes: 5, drafted: 2, idle: 3, paused: 0, blocked: 0, errors: 0,
      termination: 'deadline',
    });
  });

  it('waits one interval after idle, capped at the deadline', async () => {
    const c = clock();
    const work = scriptedWork([idle], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 11_000, intervalMs: 5_000, work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary.passes).toBe(3);
    expect(sleep.calls).toEqual([5_000, 5_000, 1_000]);
    expect(summary.termination).toBe('deadline');
    expect(summary.idle).toBe(3);
  });

  it('stops admission at the deadline while a running pass still finishes', async () => {
    const c = clock();
    const work = scriptedWork([paused], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 1_000, intervalMs: 5_000, work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary).toMatchObject({ passes: 1, paused: 1, termination: 'deadline' });
    expect(sleep.calls).toEqual([1_000]);
  });

  it('stops at maxPasses without a trailing sleep', async () => {
    const c = clock();
    const work = scriptedWork([idle], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 86_400_000, intervalMs: 5_000, maxPasses: 2,
      work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary).toMatchObject({ passes: 2, idle: 2, termination: 'max-passes' });
    expect(sleep.calls).toEqual([5_000]);
  });

  it('ends with termination signal when aborted mid-sleep', async () => {
    const c = clock();
    const work = scriptedWork([idle], c.now);
    const controller = new AbortController();
    const sleep = async (ms: number, _signal: AbortSignal) => {
      c.tick(ms);
      controller.abort();
      throw new Error('aborted');
    };
    const summary = await runCosLoop({
      durationMs: 60_000, intervalMs: 5_000, work: work.work, sleep, now: c.now,
      signal: controller.signal,
    });
    expect(summary).toMatchObject({ passes: 1, idle: 1, termination: 'signal' });
  });

  it('admits no pass on a pre-aborted signal', async () => {
    const c = clock();
    const work = scriptedWork([idle], c.now);
    const sleep = fakeSleep(c.tick);
    const controller = new AbortController();
    controller.abort();
    const summary = await runCosLoop({
      durationMs: 60_000, work: work.work, sleep: sleep.sleep, now: c.now,
      signal: controller.signal,
    });
    expect(summary).toMatchObject({ passes: 0, termination: 'signal' });
    expect(sleep.calls).toEqual([]);
  });

  it('stops after five consecutive blocked passes with the same reason', async () => {
    const c = clock();
    const work = scriptedWork([blocked('slate-empty')], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 86_400_000, intervalMs: 5_000, work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary).toMatchObject({
      passes: 5, blocked: 5, termination: 'blocked-streak', lastBlockedReason: 'slate-empty',
    });
    // One interval waited after each of the first four blocked passes only.
    expect(sleep.calls).toEqual([5_000, 5_000, 5_000, 5_000]);
  });

  it('restarts the streak when the blocked reason changes', async () => {
    const c = clock();
    const work = scriptedWork([
      blocked('r1'), blocked('r1'), blocked('r2'), blocked('r2'), blocked('r3'), blocked('r3'), idle,
    ], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 86_400_000, intervalMs: 5_000, maxPasses: 7,
      work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary).toMatchObject({
      passes: 7, blocked: 6, termination: 'max-passes', lastBlockedReason: 'r3',
    });
  });

  it('counts a throwing pass as an error and continues after an interval', async () => {
    const c = clock();
    const work = scriptedWork(['throw', drafted('cos-9'), 'throw', idle], c.now);
    const sleep = fakeSleep(c.tick);
    const summary = await runCosLoop({
      durationMs: 86_400_000, intervalMs: 5_000, maxPasses: 4,
      work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(summary).toMatchObject({
      passes: 4, errors: 2, drafted: 1, idle: 1, termination: 'max-passes',
    });
    // Interval after each errored pass; none after the drafted pass; none
    // after the final allowed pass.
    expect(sleep.calls).toEqual([5_000, 5_000]);
  });

  it('forwards runsDir, timeoutMs and now to each pass', async () => {
    const c = clock();
    const work = scriptedWork([idle], c.now);
    const sleep = fakeSleep(c.tick);
    await runCosLoop({
      durationMs: 1_000, runsDir: '/tmp/fake-runs', timeoutMs: 42_000,
      work: work.work, sleep: sleep.sleep, now: c.now,
    });
    expect(work.lastOpts()).toMatchObject({ runsDir: '/tmp/fake-runs', timeoutMs: 42_000, now: c.now });
  });
});

describe('cmdFleetCosLoop', () => {
  function cliDeps(seq: readonly (CosWorkResult | 'throw')[], signalFire?: { controller: AbortController }) {
    const c = clock();
    const work = scriptedWork(seq, c.now);
    const sleep = fakeSleep(c.tick);
    const out: string[] = [];
    const err: string[] = [];
    let unregistered = 0;
    return {
      c, work, sleep, out, err,
      deps: {
        now: c.now,
        work: work.work,
        sleep: sleep.sleep,
        output: (text: string) => { out.push(text); },
        error: (text: string) => { err.push(text); },
        onSignal: (handler: () => void) => {
          signalFire?.controller.signal.addEventListener('abort', () => handler(), { once: true });
          return () => { unregistered += 1; };
        },
      },
      unregistered: () => unregistered,
    };
  }

  it('rejects --json with --stream before any pass', async () => {
    const { deps, work } = cliDeps([idle]);
    expect(await cmdFleetCosLoop(['--duration-ms', '5000', '--json', '--stream'], deps)).toBe(2);
    expect(work.atCalls).toEqual([]);
  });

  it('rejects unknown, duplicate and invalid flags with exit 2 before any pass', async () => {
    const { deps, work } = cliDeps([idle]);
    for (const args of [
      ['--duration-ms', '5000', '--bogus'],
      ['--duration-ms', '5000', '--json', '--json'],
      ['--duration-ms', '5000', '--duration-ms', '6000'],
      ['--duration-ms', '5000', '--interval-ms', '4999'],
      ['--duration-ms', '999'],
      ['--duration-ms', '5000', '--max-passes', '0'],
      ['--duration-ms', '5000', '--max-passes', '1001'],
      ['--duration-ms', '5000', '--runs-dir', 'relative/path'],
      ['--json'],
    ]) {
      expect(await cmdFleetCosLoop(args, deps), JSON.stringify(args)).toBe(2);
    }
    expect(work.atCalls).toEqual([]);
  });

  it('prints one sanitized JSON summary with --json', async () => {
    const { deps, out } = cliDeps([idle]);
    expect(await cmdFleetCosLoop(['--duration-ms', '5000', '--json'], deps)).toBe(0);
    const summary = JSON.parse(out.join('\n'));
    expect(summary).toMatchObject({ v: 1, passes: 1, idle: 1, termination: 'deadline' });
    expect(summary.record).toBeUndefined();
  });

  it('emits one pass line per pass plus one summary line with --stream', async () => {
    const { deps, out } = cliDeps([drafted('cos-1'), idle, blocked('slate-empty', 'cos-2')]);
    const code = await cmdFleetCosLoop(
      ['--duration-ms', '20000', '--interval-ms', '5000', '--max-passes', '3', '--stream'], deps);
    expect(code).toBe(0);
    expect(out).toHaveLength(4);
    const lines = out.map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ v: 1, record: 'pass', pass: 1, outcome: 'drafted', id: 'cos-1' });
    expect(lines[1]).toEqual({ v: 1, record: 'pass', pass: 2, outcome: 'idle' });
    expect(lines[2]).toEqual({ v: 1, record: 'pass', pass: 3, outcome: 'blocked', id: 'cos-2' });
    expect(lines[3]).toMatchObject({ v: 1, record: 'summary', passes: 3, termination: 'max-passes' });
  });

  it('exits 1 on an errored pass', async () => {
    const { deps } = cliDeps(['throw']);
    expect(await cmdFleetCosLoop(['--duration-ms', '5000', '--max-passes', '1'], deps)).toBe(1);
  });

  it('exits 1 on blocked-streak', async () => {
    const { deps } = cliDeps([blocked('slate-empty')]);
    expect(await cmdFleetCosLoop(['--duration-ms', '86400000', '--stream'], deps)).toBe(1);
  });

  it('stops admission on signal and unregisters the listeners', async () => {
    const controller = new AbortController();
    const { deps, out, unregistered } = cliDeps([idle], { controller });
    deps.sleep = async (_ms: number) => {
      controller.abort();
      throw new Error('aborted');
    };
    expect(await cmdFleetCosLoop(['--duration-ms', '60000', '--json'], deps)).toBe(0);
    const summary = JSON.parse(out.join('\n'));
    expect(summary.termination).toBe('signal');
    expect(unregistered()).toBe(1);
  });

  it('registers cos-loop in the fleet subcommand registry', () => {
    expect(FLEET_SUBCOMMAND_LOADERS).toHaveProperty('cos-loop');
  });
});
