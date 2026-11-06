/**
 * RQ-PHX-SELFLOOP02SOLY1 — `ashlr fleet self-loop` repeats the real
 * cmdFleetSelfTick for a bounded window with no desktop and no shell timer.
 * Clocks, ticks and sleeps are faked; the runs dir is a temp dir; no real
 * provider, planner child or machine state is ever touched.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';
import { SELF_TICK_LOCK, type SelfTickStep, type SelfTickStepName } from '../src/core/fleet/self-tick.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-loop-'));
  await mkdir(join(runsDir, 'queue'));
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

interface Summary {
  v: number; startedAt: string; endedAt: string; elapsedMs: number;
  durationMs: number; intervalMs: number; ticks: number; failures: number;
  busy: number; termination: string; lastReport: Record<string, unknown> | null;
}
type Deps = NonNullable<Parameters<typeof cmdFleetSelfLoop>[1]>;

const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfLoop(args, {
    ...deps, output: (t) => out.push(t), error: (t) => err.push(t),
  });
  return { code, outLines: out, stderr: err.join('\n'),
    summary: (out.length === 1 && out[0]!.startsWith('{') ? JSON.parse(out[0]!) : null) as Summary | null };
};

/** Fake clock whose sleep seam auto-advances it by the requested interval. */
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps, sleep };
};

/** Step stubs recording call order and argv, each yielding an ok report. */
const recordingSteps = () => {
  const order: string[] = [];
  const argvs: string[][] = [];
  const stub = (name: SelfTickStepName): SelfTickStep => async (args) => {
    order.push(name);
    argvs.push([...args]);
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  };
  return { order, argvs, steps: {
    'reset-release': stub('reset-release'),
    'lane-autohold': stub('lane-autohold'),
    'planner-tick': stub('planner-tick'),
    'inbox-acks': stub('inbox-acks'),
    'order-notices': stub('order-notices'),
    'landed-sweep': stub('landed-sweep'),
  } };
};

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('fleet self-loop', () => {
  it('resolves through the fleet convention resolver to the real module export', async () => {
    expect(resolveFleetSubcommand('self-loop'))
      .toEqual({ module: './fleet-self-loop.js', exportName: 'cmdFleetSelfLoop' });
    const loaded = await import('../src/cli/fleet-self-loop.js');
    expect(typeof loaded.cmdFleetSelfLoop).toBe('function');
  });

  it('--help prints usage and exits 0 without any pass', async () => {
    let ticks = 0;
    const { code, outLines } = await run(['--help'], { tick: async () => { ticks++; return { exitCode: 0, report: null }; } });
    expect(code).toBe(0);
    expect(ticks).toBe(0);
    expect(outLines.join('\n')).toContain('Usage: ashlr fleet self-loop');
  });

  it('runs the first pass immediately, then one interval apart, never overlapping', async () => {
    const clock = fakeClock();
    const startedAt: number[] = [];
    let active = 0, maxActive = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      active++; maxActive = Math.max(maxActive, active);
      startedAt.push(clock.now());
      await flush();
      active--;
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const { code, summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(startedAt).toEqual([0, 1000, 2000]);
    expect(clock.sleeps).toEqual([1000, 1000, 500]); // last wait caps to remaining budget
    expect(maxActive).toBe(1);
    expect(summary).toMatchObject({ ticks: 3, failures: 0, busy: 0, termination: 'duration',
      durationMs: 2500, intervalMs: 1000, elapsedMs: 2500 });
  });

  it('admits no pass after the deadline; an over-running pass finishes normally', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      clock.advance(500); // a slow pass finishing well past the deadline
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const { code, summary } = await run(
      ['--json', '--duration-ms', '100', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ ticks: 1, termination: 'duration', elapsedMs: 500 });
    expect(clock.sleeps).toEqual([]);
  });

  it('honours the 24h cap boundary and the default interval', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'ran' } });
    const { code, summary } = await run(['--json', '--duration-ms', '120000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ ticks: 2, intervalMs: 60000 });
    expect(clock.sleeps).toEqual([60000, 60000]);
    const capped = await run(['--json', '--duration-ms', String(24 * 60 * 60 * 1000), '--interval-ms', '43200000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(capped.code).toBe(0);
    expect(capped.summary!.ticks).toBe(2);
  });

  it('keeps counters and only the latest report — no per-tick history', async () => {
    const clock = fakeClock();
    let n = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran', seq: ++n, pad: 'x'.repeat(4096) } });
    const { code, summary } = await run(
      ['--json', '--duration-ms', '5000', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(Object.keys(summary!).sort()).toEqual([
      'busy', 'durationMs', 'elapsedMs', 'endedAt', 'failures', 'intervalMs',
      'lastReport', 'startedAt', 'termination', 'ticks', 'v',
    ]);
    expect(summary!.ticks).toBe(5);
    expect(summary!.lastReport).toMatchObject({ seq: 5 });
  });

  it('a failed or throwing pass is counted and the loop continues', async () => {
    const clock = fakeClock();
    const exits = [1, 0, 0]; // pass two throws instead of using this table
    let n = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      const i = n++;
      if (i === 1) throw new Error('boom');
      return { exitCode: exits[i] ?? 0, report: { state: 'ran', seq: i + 1 } };
    };
    const { code, summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    expect(summary).toMatchObject({ ticks: 3, failures: 2, termination: 'duration' });
    expect(summary!.lastReport).toMatchObject({ seq: 3 });
  });

  it('a busy pass is counted, not failed, and does not stop the loop', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'busy', steps: [] } });
    const { code, summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ ticks: 3, busy: 3, failures: 0 });
    expect(summary!.lastReport).toMatchObject({ state: 'busy' });
  });

  it('a signal during sleep interrupts admission, reports, and unregisters its listeners', async () => {
    let signalHandler: (() => void) | null = null;
    let removed = 0;
    let sleeping = false;
    const tick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'ran' } });
    const sleep = (_ms: number, signal: AbortSignal) => new Promise<void>((_res, rej) => {
      sleeping = true;
      if (signal.aborted) { rej(new Error('aborted')); return; }
      signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
    });
    const out: string[] = [];
    const promise = cmdFleetSelfLoop(['--json', '--duration-ms', '60000', '--interval-ms', '1000'], {
      tick, sleep, now: () => 0,
      output: (t) => out.push(t), error: () => {},
      onSignal: (handler) => { signalHandler = handler; return () => { removed++; }; },
    });
    await flush();
    expect(sleeping).toBe(true);
    signalHandler!();
    const code = await promise;
    expect(code).toBe(0);
    expect(removed).toBe(1); // the listener is gone before the summary prints
    const summary = JSON.parse(out[0]!) as Summary;
    expect(summary).toMatchObject({ ticks: 1, termination: 'interrupted' });
  });

  it('a pass in flight when the signal lands finishes normally, then the loop stops', async () => {
    let signalHandler: (() => void) | null = null;
    let resolveTick!: (outcome: SelfLoopTickOutcome) => void;
    let ticks = 0;
    const sleeps: number[] = [];
    const tick = () => new Promise<SelfLoopTickOutcome>((res) => { ticks++; resolveTick = res; });
    const out: string[] = [];
    const promise = cmdFleetSelfLoop(['--json', '--duration-ms', '60000', '--interval-ms', '1000'], {
      tick, now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      output: (t) => out.push(t), error: () => {},
      onSignal: (handler) => { signalHandler = handler; return () => {}; },
    });
    await flush();
    expect(ticks).toBe(1);
    signalHandler!();
    resolveTick({ exitCode: 0, report: { state: 'ran' } });
    const code = await promise;
    expect(code).toBe(0);
    expect(sleeps).toEqual([]); // no admission or waiting after the interrupt
    expect(JSON.parse(out[0]!)).toMatchObject({ ticks: 1, termination: 'interrupted' });
  });

  it('the default signal path registers on the process and cleans up after the run', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      observed = [process.listenerCount('SIGINT') - baseline[0], process.listenerCount('SIGTERM') - baseline[1]];
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const baseline = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    let observed: number[] = [];
    const { code } = await run(['--json', '--duration-ms', '1'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(observed).toEqual([1, 1]);
    expect(process.listenerCount('SIGINT')).toBe(baseline[0]);
    expect(process.listenerCount('SIGTERM')).toBe(baseline[1]);
  });

  it('bad arguments exit 2 before any pass runs', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks++; return { exitCode: 0, report: null }; };
    for (const args of [
      [], ['--duration-ms'], ['--duration-ms', 'abc'], ['--duration-ms', '0'],
      ['--duration-ms', '-1'], ['--duration-ms', '1.5'], ['--duration-ms', '86400001'],
      ['--duration-ms', '99999999999999999999999'],
      ['--duration-ms', '1000', '--interval-ms', '999'],
      ['--duration-ms', '1000', '--interval-ms', '0'],
      ['--duration-ms', '1000', '--interval-ms', 'x'],
      ['--duration-ms', '1000', '--interval-ms'],
      ['--bogus', '--duration-ms', '1000'], ['positional', '--duration-ms', '1000'],
      ['--duration-ms', '1000', '--duration-ms', '2000'],
      ['--json', '--json', '--duration-ms', '1000'],
      ['--apply', '--apply', '--duration-ms', '1000'],
      ['--runs-dir', runsDir, '--runs-dir', runsDir, '--duration-ms', '1000'],
      ['--duration-ms=1000'], ['--duration-ms', '1000', '--runs-dir', 'relative/path'],
    ]) {
      const { code, stderr } = await run(args, { tick });
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('Usage: ashlr fleet self-loop');
    }
    expect(ticks).toBe(0);
  });

  it('every pass is the real self-tick: ordered steps, --apply and root forwarded, stdout contained', async () => {
    const clock = fakeClock();
    const rec = recordingSteps();
    const { code, summary, outLines } = await run(
      ['--json', '--apply', '--duration-ms', '2500', '--interval-ms', '1000', '--runs-dir', runsDir],
      { steps: rec.steps, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(rec.order).toEqual([
      'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices', 'landed-sweep',
      'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices', 'landed-sweep',
      'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices', 'landed-sweep',
    ]);
    for (const [index, argv] of rec.argvs.entries()) {
      const flag = rec.order[index] === 'inbox-acks' ? '--flush' : '--apply';
      expect(argv).toEqual(expect.arrayContaining(['--json', flag, '--runs-dir', runsDir]));
    }
    // Nested tick stdout never leaks: exactly one JSON line, whose lastReport
    // carries the parsed pass report for the final of the three passes.
    expect(outLines.length).toBe(1);
    expect(summary).toMatchObject({ ticks: 3, failures: 0, busy: 0, termination: 'duration' });
    expect(summary!.lastReport).toMatchObject({ mode: 'apply', state: 'ran' });
    expect(summary!.lastReport!['steps']).toHaveLength(6);
  });

  it('dry-run is the default: no --apply is forwarded and nothing is applied', async () => {
    const clock = fakeClock();
    const rec = recordingSteps();
    const { code, summary } = await run(
      ['--json', '--duration-ms', '1', '--runs-dir', runsDir],
      { steps: rec.steps, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(rec.argvs.every((argv) => !argv.includes('--apply'))).toBe(true);
    expect(summary!.lastReport).toMatchObject({ mode: 'dry-run', state: 'ran' });
  });

  it('a held self-tick lock folds into the busy counter through the real wrapper path', async () => {
    const clock = fakeClock();
    const held = acquireLocalStoreLockWithOutcome(join(runsDir, SELF_TICK_LOCK), 0,
      { anchorPath: runsDir, exactPrivateStorage: true });
    expect(held.state).toBe('acquired');
    try {
      const rec = recordingSteps();
      const { code, summary } = await run(
        ['--json', '--duration-ms', '2500', '--interval-ms', '1000', '--runs-dir', runsDir],
        { steps: rec.steps, now: clock.now, sleep: clock.sleep });
      expect(code).toBe(0);
      expect(rec.order).toEqual([]); // busy passes run no step
      expect(summary).toMatchObject({ ticks: 3, busy: 3, failures: 0 });
      expect(summary!.lastReport).toMatchObject({ state: 'busy' });
    } finally {
      releaseLocalStoreLock(held.state === 'acquired' ? held.lock : null);
    }
  });

  it('human output reports ticks, failures, busy and the termination reason', async () => {
    const clock = fakeClock();
    let n = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: n++ === 1 ? 1 : 0, report: { state: 'ran' } });
    const { code, outLines } = await run(['--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    expect(outLines.join('\n')).toContain('fleet self-loop: DONE — ticks=3 failed=1 busy=0 (dry-run)');
  });
});
