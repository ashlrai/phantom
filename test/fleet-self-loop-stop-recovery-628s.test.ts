/**
 * RQ-PHX-LOOPSTOPRECOVER628S — graceful --stop-file admission stop for
 * `ashlr fleet self-loop` (recovered from PR #5848's two self-loop paths).
 *
 * Everything runs through the real cmdFleetSelfLoop / runSelfLoop path with
 * injected ticks, clocks and sleeps and a temporary fake runs root; no real
 * home, provider, planner child or network is touched.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import { runSelfLoop, watchSelfLoopStopFile } from '../src/core/fleet/self-loop.js';
import { readDeliveredEnvelopes } from '../src/core/fleet/self-loop-bus-progress.js';

let root: string;
let stopFile: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'self-loop-stop-628s-'));
  await mkdir(join(root, 'queue'));
  stopFile = join(root, 'STOP');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

type Deps = NonNullable<Parameters<typeof cmdFleetSelfLoop>[1]>;
const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfLoop(args, { ...deps, output: (t) => out.push(t), error: (t) => err.push(t) });
  return { code, out, stderr: err.join('\n'), summary: out.length === 1 && out[0]!.startsWith('{') ? JSON.parse(out[0]!) : null };
};
const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, sleeps, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } };
};
const ranTick = (counter: { n: number }, during?: () => Promise<void>) => async () => {
  counter.n += 1;
  await during?.();
  return { exitCode: 0, report: { state: 'ran' } };
};
const base = () => ['--json', '--duration-ms', '60000', '--interval-ms', '1000', '--runs-dir', root];

describe('--stop-file admission', () => {
  it('a preexisting stop file admits zero ticks and is left untouched', async () => {
    await writeFile(stopFile, 'keep me');
    const clock = fakeClock(), c = { n: 0 };
    const r = await run([...base(), '--stop-file', stopFile], { tick: ranTick(c), now: clock.now, sleep: clock.sleep });
    expect(r.code).toBe(0);
    expect(c.n).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(r.summary).toMatchObject({ ticks: 0, termination: 'stop-file' });
    expect(await readFile(stopFile, 'utf8')).toBe('keep me');
  });

  it('absent option keeps default behavior and never creates the file', async () => {
    const clock = fakeClock(), c = { n: 0 };
    const r = await run(['--json', '--duration-ms', '2500', '--interval-ms', '1000', '--runs-dir', root],
      { tick: ranTick(c), now: clock.now, sleep: clock.sleep });
    expect(c.n).toBe(3);
    expect(r.summary.termination).toBe('duration');
  });

  it('a stop created during a pass lets that pass finish and admits no more', async () => {
    const clock = fakeClock(), c = { n: 0 };
    const r = await run([...base(), '--stop-file', stopFile], {
      tick: ranTick(c, () => writeFile(stopFile, '')), now: clock.now, sleep: clock.sleep,
    });
    expect(c.n).toBe(1);
    expect(r.code).toBe(0);
    expect(r.summary).toMatchObject({ ticks: 1, failures: 0, termination: 'stop-file' });
  });

  it('a stop created during the idle wait wakes admission promptly and releases the sleep timer', async () => {
    const c = { n: 0 };
    let sleepStarted!: () => void;
    const started = new Promise<void>((r) => { sleepStarted = r; });
    let sleepSignal: AbortSignal | undefined;
    // A sleep that would outlast the test unless woken; rejects on abort like the real one.
    const sleep = (_ms: number, signal: AbortSignal) => new Promise<void>((_res, rej) => {
      sleepSignal = signal;
      signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      sleepStarted();
    });
    const pending = run([...base(), '--stop-file', stopFile], { tick: ranTick(c), sleep });
    await started;
    expect(c.n).toBe(1);
    await writeFile(stopFile, '');
    const r = await pending; // a hang here fails via the test timeout
    expect(c.n).toBe(1);
    expect(r.summary).toMatchObject({ ticks: 1, termination: 'stop-file' });
    expect(sleepSignal?.aborted).toBe(true); // losing sleep released
  }, 10_000);

  it('a non-ENOENT existence error ends as stop-check-error with exit 1 and no tick', async () => {
    const blocker = join(root, 'plain-file');
    await writeFile(blocker, 'x');
    const clock = fakeClock(), c = { n: 0 };
    const r = await run([...base(), '--stop-file', join(blocker, 'STOP')], { tick: ranTick(c), now: clock.now, sleep: clock.sleep });
    expect(r.code).toBe(1);
    expect(c.n).toBe(0);
    expect(r.summary.termination).toBe('stop-check-error');
    const human = await run(['--duration-ms', '5000', '--runs-dir', root, '--stop-file', join(blocker, 'STOP')],
      { tick: ranTick(c), now: clock.now, sleep: clock.sleep });
    expect(human.code).toBe(1);
    expect(human.out[0]).toContain('STOP-CHECK-ERROR');
  });

  it('human output labels a stop-file ending', async () => {
    await writeFile(stopFile, '');
    const r = await run(['--duration-ms', '5000', '--runs-dir', root, '--stop-file', stopFile], { tick: ranTick({ n: 0 }) });
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain('STOPPED-BY-FILE');
  });

  it('rejects invalid input before any tick', async () => {
    const c = { n: 0 };
    const cases: string[][] = [
      ['--stop-file'],
      ['--stop-file', 'relative/STOP'],
      ['--stop-file', `${stopFile}\nX`],
      ['--stop-file', `${stopFile}\u0007`],
      ['--stop-file', stopFile, '--stop-file', stopFile],
    ];
    for (const extra of cases) {
      const r = await run([...base(), ...extra], { tick: ranTick(c) });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Invalid arguments');
    }
    expect(c.n).toBe(0);
  });

  it('composes with bus progress: the completed pass is recorded exactly once', async () => {
    const busRoot = join(root, 'bus');
    const clock = fakeClock(), c = { n: 0 };
    const r = await run([...base(), '--stop-file', stopFile, '--bus-to', 'agent-supervisor', '--bus-root', busRoot, '--bus-run-id', 'run-628s'], {
      tick: ranTick(c, () => writeFile(stopFile, '')), now: clock.now, sleep: clock.sleep,
    });
    expect(r.code).toBe(0);
    expect(c.n).toBe(1);
    const page = readDeliveredEnvelopes({ root: busRoot });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') return;
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.envelope.id).toBe('run-628s::pass-1');
    expect(r.summary.termination).toBe('stop-file');
  });
});

describe('runSelfLoop stop seams', () => {
  it('never spins: a stopObserved that settles once wakes a single admission check', async () => {
    let checks = 0, observed = 0;
    const clock = fakeClock();
    const summary = await runSelfLoop({
      durationMs: 60_000, intervalMs: 1000, now: clock.now,
      tick: async () => ({ exitCode: 0, report: null }),
      checkStop: async () => (++checks === 1 ? 'continue' : 'stop'),
      stopObserved: () => { observed += 1; return Promise.resolve(); },
      sleep: () => new Promise<void>(() => {}), // only the observation can wake the loop
    });
    expect(summary).toMatchObject({ ticks: 1, termination: 'stop-file' });
    expect(checks).toBe(2);
    expect(observed).toBe(1);
  });

  it('a rejecting checkStop mid-run ends as stop-check-error without another pass', async () => {
    let checks = 0, ticks = 0;
    const clock = fakeClock();
    const summary = await runSelfLoop({
      durationMs: 60_000, intervalMs: 1000, now: clock.now, sleep: clock.sleep,
      tick: async () => { ticks += 1; return { exitCode: 0, report: null }; },
      checkStop: async () => { if (++checks === 2) throw new Error('EACCES'); return 'continue'; },
    });
    expect(ticks).toBe(1);
    expect(summary.termination).toBe('stop-check-error');
  });

  it('watch events are confirmed by an existence read, observed once, and close is idempotent', async () => {
    const admission = watchSelfLoopStopFile(stopFile);
    try {
      await writeFile(join(root, 'unrelated'), ''); // event without the stop file: must not settle
      const first = admission.stopObserved();
      await writeFile(stopFile, '');
      await first; // settles once the watch confirms the file (bounded by test timeout)
      await admission.stopObserved(); // delivered once after firing
      const settled = await Promise.race([
        admission.stopObserved().then(() => 'again'),
        new Promise<string>((r) => setTimeout(() => r('quiet'), 50)),
      ]);
      expect(settled).toBe('quiet'); // never spins
    } finally {
      admission.close();
      admission.close();
    }
    expect(await admission.checkStop()).toBe('stop');
  }, 10_000);
});
