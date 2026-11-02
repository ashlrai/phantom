/**
 * RQ-PHX-SELFLOOPSTOPFILE02SOLD2 — an explicit operator stop file gates
 * admission to `ashlr fleet self-loop`: a preexisting file prevents the first
 * pass; creation during the idle wait wakes admission promptly (an
 * event-driven watch, no polling, sleep left unresolved); creation mid-pass
 * lets that pass finish with zero additional passes; a missing file leaves
 * repetition untouched and is never created by the loop; a filesystem error
 * stops admission loudly with a nonzero result; bad or duplicate CLI values
 * run no pass. Stop paths live in isolated temp dirs, clock and sleep are
 * faked, and the only real time spent is the bounded watch latency.
 */
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import { runSelfLoop, watchSelfLoopStopFile, type SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'self-loop-stop-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

type Deps = NonNullable<Parameters<typeof cmdFleetSelfLoop>[1]>;
const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfLoop(args, {
    ...deps, output: (t) => out.push(t), error: (t) => err.push(t),
  });
  return { code, outLines: out, stderr: err.join('\n'),
    summary: (out.length === 1 && out[0]!.startsWith('{') ? JSON.parse(out[0]!) : null) as Record<string, unknown> | null };
};

/** Fake clock whose sleep seam auto-advances it by the requested interval. */
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, sleeps, sleep };
};

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Await a condition across real I/O turns (fs reads land off the microtask queue). */
const until = async (condition: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error('condition not met within bound');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Settle a promise within a real bound; the happy path spends no wait. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, bound]); } finally { clearTimeout(timer!); }
};

describe('fleet self-loop stop file', () => {
  it('a preexisting stop file prevents the first pass and is left untouched', async () => {
    const stop = join(dir, 'stop');
    await writeFile(stop, 'halt\n');
    const clock = fakeClock();
    let ticks = 0;
    const { code, summary } = await run(
      ['--json', '--duration-ms', '60000', '--interval-ms', '1000', '--stop-file', stop],
      { tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
        now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(ticks).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(summary).toMatchObject({ ticks: 0, termination: 'stop-file', lastReport: null });
    await expect(readFile(stop, 'utf8')).resolves.toBe('halt\n');
  });

  it('creation during the idle wait wakes admission promptly without resolving the sleep', async () => {
    const stop = join(dir, 'stop');
    let ticks = 0, sleepResolved = 0;
    const sleep = () => {
      const promise = new Promise<void>(() => {}); // hangs; only the watch may wake admission
      void promise.then(() => { sleepResolved++; });
      return promise;
    };
    const out: string[] = [];
    const promise = cmdFleetSelfLoop(
      ['--json', '--duration-ms', '600000', '--interval-ms', '60000', '--stop-file', stop],
      { tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
        now: () => 0, sleep, output: (t) => out.push(t), error: () => {} });
    await until(() => ticks === 1);
    await flush();
    await writeFile(stop, 'stop\n');
    const code = await within(promise, 2000); // watch latency, no long real sleep
    expect(code).toBe(0);
    expect(ticks).toBe(1);
    expect(sleepResolved).toBe(0); // the wait was abandoned, never slept out
    expect(JSON.parse(out[0]!)).toMatchObject({ ticks: 1, termination: 'stop-file' });
  });

  it('creation during a running pass lets the pass finish, then stops admission', async () => {
    const stop = join(dir, 'stop');
    let ticks = 0, passFinished = false;
    let resolveTick!: (outcome: SelfLoopTickOutcome) => void;
    const tick = () => new Promise<SelfLoopTickOutcome>((res) => { ticks++; resolveTick = res; })
      .then((outcome) => { passFinished = true; return outcome; });
    const out: string[] = [];
    const promise = cmdFleetSelfLoop(
      ['--json', '--duration-ms', '600000', '--interval-ms', '60000', '--stop-file', stop],
      { tick, now: () => 0, sleep: () => new Promise<void>(() => {}),
        output: (t) => out.push(t), error: () => {} });
    await until(() => ticks === 1);
    await writeFile(stop, 'stop\n'); // lands while the pass is still in flight
    resolveTick({ exitCode: 0, report: { state: 'ran' } });
    const code = await within(promise, 2000);
    expect(code).toBe(0);
    expect(passFinished).toBe(true); // the in-flight pass was never interrupted
    expect(ticks).toBe(1); // zero additional passes
    expect(JSON.parse(out[0]!)).toMatchObject({ ticks: 1, termination: 'stop-file',
      lastReport: { state: 'ran' } });
  });

  it('a missing stop file preserves interval repetition and is never created', async () => {
    const stop = join(dir, 'stop');
    const clock = fakeClock();
    let ticks = 0;
    const { code, summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000', '--stop-file', stop],
      { tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
        now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(ticks).toBe(3);
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
    expect(summary).toMatchObject({ ticks: 3, termination: 'duration' });
    await expect(lstat(stop)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a filesystem error on the stop path stops admission loudly before any pass', async () => {
    await writeFile(join(dir, 'plain'), 'x');
    const stop = join(dir, 'plain', 'stop'); // every read fails ENOTDIR
    const clock = fakeClock();
    let ticks = 0;
    const deps: Deps = { tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
      now: clock.now, sleep: clock.sleep };
    const { code, summary } = await run(
      ['--json', '--duration-ms', '60000', '--interval-ms', '1000', '--stop-file', stop], deps);
    expect(code).toBe(1); // a stop-check error is a clear nonzero result
    expect(ticks).toBe(0); // admission never silently keeps launching
    expect(summary).toMatchObject({ ticks: 0, termination: 'stop-check-error' });
    const human = await run(['--duration-ms', '60000', '--interval-ms', '1000', '--stop-file', stop], deps);
    expect(human.code).toBe(1);
    expect(human.outLines.join('\n'))
      .toContain('fleet self-loop: STOP-CHECK-ERROR — ticks=0 failed=0 busy=0 (dry-run)');
    expect(ticks).toBe(0);
  });

  it('bad, duplicate or missing --stop-file values exit 2 before any pass runs', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks++; return { exitCode: 0, report: null }; };
    for (const args of [
      ['--duration-ms', '1000', '--stop-file', 'relative/path'],
      ['--duration-ms', '1000', '--stop-file', ''],
      ['--duration-ms', '1000', '--stop-file'],
      ['--duration-ms', '1000', '--stop-file', join(dir, 'a'), '--stop-file', join(dir, 'b')],
      ['--duration-ms', '1000', '--stop-file', `${dir}/has\nnewline`],
      ['--duration-ms', '1000', '--stop-file', `${dir}/has\ttab`],
      ['--duration-ms', '1000', '--stop-file', `${dir}/has\x7fdel`],
    ]) {
      const { code, stderr } = await run(args, { tick });
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('Usage: ashlr fleet self-loop');
    }
    expect(ticks).toBe(0);
  });

  it('human output distinguishes the stop-file termination', async () => {
    const stop = join(dir, 'stop');
    await writeFile(stop, 'stop\n');
    const { code, outLines } = await run(
      ['--duration-ms', '60000', '--interval-ms', '1000', '--stop-file', stop],
      { tick: async () => ({ exitCode: 0, report: null }), now: () => 0, sleep: async () => {} });
    expect(code).toBe(0);
    expect(outLines.join('\n')).toContain('fleet self-loop: STOPPED-BY-FILE — ticks=0 failed=0 busy=0 (dry-run)');
  });
});

describe('runSelfLoop stop seams', () => {
  it('checkStop gates every pass; a rejection ends the loop as stop-check-error', async () => {
    const clock = fakeClock();
    let calls = 0, ticks = 0;
    const summary = await runSelfLoop({
      durationMs: 10000, intervalMs: 1000,
      tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
      now: clock.now, sleep: clock.sleep,
      checkStop: async () => {
        calls++;
        if (calls === 2) throw new Error('ENOTDIR: not a directory');
        return 'continue';
      },
    });
    expect(calls).toBe(2); // before the first pass, then before the second
    expect(ticks).toBe(1);
    expect(summary).toMatchObject({ ticks: 1, failures: 0, termination: 'stop-check-error' });
  });

  it('an observed stop wakes the raced sleep and ends admission on the next check', async () => {
    const clock = fakeClock();
    let ticks = 0, observations = 0;
    const summary = await runSelfLoop({
      durationMs: 10000, intervalMs: 1000,
      tick: async () => { ticks++; return { exitCode: 0, report: { state: 'ran' } }; },
      now: clock.now,
      sleep: () => new Promise<void>(() => {}), // hangs; only the observation wakes
      checkStop: async () => (ticks >= 1 ? 'stop' : 'continue'),
      stopObserved: () => { observations++; return Promise.resolve(); },
    });
    expect(observations).toBe(1); // one race, woken at once
    expect(summary).toMatchObject({ ticks: 1, termination: 'stop-file' });
  });

  it('watchSelfLoopStopFile reads only: missing continues, presence stops, errors reject, close is idempotent', async () => {
    const stop = join(dir, 'stop');
    const admission = watchSelfLoopStopFile(stop);
    expect(await admission.checkStop()).toBe('continue');
    await writeFile(stop, 'stop\n');
    expect(await admission.checkStop()).toBe('stop');
    await expect(readFile(stop, 'utf8')).resolves.toBe('stop\n'); // never rewritten
    admission.close();
    admission.close();
    const orphan = watchSelfLoopStopFile(join(dir, 'missing-parent', 'stop'));
    expect(await orphan.checkStop()).toBe('continue'); // missing parent reads as absent
    orphan.close();
    await writeFile(join(dir, 'plain'), 'x');
    const broken = watchSelfLoopStopFile(join(dir, 'plain', 'stop'));
    await expect(broken.checkStop()).rejects.toMatchObject({ code: 'ENOTDIR' });
    broken.close();
  });
});
