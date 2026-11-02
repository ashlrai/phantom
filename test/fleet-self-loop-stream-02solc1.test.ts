/**
 * RQ-PHX-SELFLOOPPROGRESS02SOLC1 — `ashlr fleet self-loop --stream` emits
 * sanitized NDJSON per completed pass plus one distinguishable final summary
 * while the loop still runs. Clocks, ticks and sleeps are faked; the runs
 * dir is a temp dir; no real provider, planner child or machine state is
 * ever touched.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop, SELF_LOOP_STREAM_MAX_CHARS } from '../src/cli/fleet-self-loop.js';
import type { SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';
import type { SelfTickStep, SelfTickStepName } from '../src/core/fleet/self-tick.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-loop-stream-'));
  await mkdir(join(runsDir, 'queue'));
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

type Deps = NonNullable<Parameters<typeof cmdFleetSelfLoop>[1]>;

const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfLoop(args, {
    ...deps, output: (t) => out.push(t), error: (t) => err.push(t),
  });
  return { code, lines: out, stderr: err.join('\n'),
    records: out.filter((t) => t.startsWith('{')).map((t) => JSON.parse(t) as Record<string, unknown>) };
};

const fakeClock = () => {
  let now = 0;
  const sleep = async (ms: number) => { now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleep };
};

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('fleet self-loop --stream', () => {
  it('emits the first pass before a deferred second pass completes, then one final summary', async () => {
    const clock = fakeClock();
    let resolveSecond!: (outcome: SelfLoopTickOutcome) => void;
    let ticks = 0;
    const tick = () => new Promise<SelfLoopTickOutcome>((res) => {
      ticks += 1;
      if (ticks === 1) res({ exitCode: 0, report: { state: 'ran', seq: 1 } });
      else resolveSecond = res;
    });
    const lines: string[] = [];
    const promise = cmdFleetSelfLoop(['--stream', '--duration-ms', '2500', '--interval-ms', '1000'], {
      tick, now: clock.now, sleep: clock.sleep,
      output: (t) => lines.push(t), error: () => {},
    });
    await flush();
    // The loop is parked on the still-deferred second pass: the supervisor
    // already holds pass 1 and has NOT seen any summary.
    expect(ticks).toBe(2);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject(
      { v: 1, record: 'pass', pass: 1, exitCode: 0, state: 'ran', report: { state: 'ran', seq: 1 } });
    clock.advance(100_000); // far past the deadline while pass 2 flies on
    resolveSecond({ exitCode: 0, report: { state: 'ran', seq: 2 } });
    const code = await promise;
    expect(code).toBe(0);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toMatchObject({ record: 'pass', pass: 2, state: 'ran' });
    const final = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(final).toMatchObject({ v: 1, record: 'summary' });
    expect(final).toMatchObject({ ticks: 2, failures: 0, termination: 'duration' });
    expect(lines.filter((l) => JSON.parse(l)['record'] === 'summary')).toHaveLength(1);
  });

  it('success, failure (throwing tick) and busy passes are each visible as they happen', async () => {
    const clock = fakeClock();
    let n = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return n === 3
        ? { exitCode: 0, report: { state: 'busy', steps: [] } }
        : { exitCode: 0, report: { state: 'ran', seq: n } };
    };
    const { code, records } = await run(['--stream', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    expect(records).toHaveLength(4); // three passes + exactly one summary, in order
    expect(records[0]).toMatchObject({ record: 'pass', pass: 1, exitCode: 0, state: 'ran' });
    expect(records[1]).toMatchObject({ record: 'pass', pass: 2, exitCode: 1, state: null, report: null });
    expect(records[2]).toMatchObject({ record: 'pass', pass: 3, exitCode: 0, state: 'busy' });
    expect(records[3]).toMatchObject({ record: 'summary' });
    expect(records[3]).toMatchObject({ ticks: 3, failures: 1, busy: 1, termination: 'duration' });
    for (const r of records) expect(r['v']).toBe(1);
  });

  it('a stop signal ends admission, still emits the in-flight pass, and unregisters listeners', async () => {
    let signalHandler: (() => void) | null = null;
    let removed = 0;
    let ticks = 0;
    let resolveTick!: (outcome: SelfLoopTickOutcome) => void;
    const tick = () => new Promise<SelfLoopTickOutcome>((res) => { ticks += 1; resolveTick = res; });
    const lines: string[] = [];
    const promise = cmdFleetSelfLoop(['--stream', '--duration-ms', '60000', '--interval-ms', '1000'], {
      tick, now: () => 0, sleep: async () => {},
      output: (t) => lines.push(t), error: () => {},
      onSignal: (handler) => { signalHandler = handler; return () => { removed += 1; }; },
    });
    await flush();
    expect(ticks).toBe(1);
    expect(lines).toHaveLength(0); // the pass is still in flight — nothing said yet
    signalHandler!();
    resolveTick({ exitCode: 0, report: { state: 'ran' } });
    const code = await promise;
    expect(code).toBe(0);
    expect(removed).toBe(1); // gone before the final record printed
    expect(ticks).toBe(1); // no admission after the interrupt
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ record: 'pass', pass: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ record: 'summary', ticks: 1, termination: 'interrupted' });
  });

  it('streamed lines are sanitized and never exceed the line cap', async () => {
    const clock = fakeClock();
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const tick = async (): Promise<SelfLoopTickOutcome> => ({
      exitCode: 0,
      report: { state: 'ran', note: `token ${secret}`, pad: 'x'.repeat(200_000) },
    });
    const { code, lines, records } = await run(['--stream', '--duration-ms', '100', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(lines).toHaveLength(2); // one pass + one summary
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(SELF_LOOP_STREAM_MAX_CHARS);
      expect(line).not.toContain(secret);
      expect(line).not.toContain('x'.repeat(SELF_LOOP_STREAM_MAX_CHARS));
    }
    expect(records[0]).toMatchObject({ record: 'pass', reportTruncated: true });
    expect(String(records[0]!['report'])).toContain('…[truncated]');
    expect(records[1]).toMatchObject({ record: 'summary', reportTruncated: true });
  });

  it('a small report streams whole, without truncation markers', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran', note: 'plain' } });
    const { code, records } = await run(['--stream', '--duration-ms', '100', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(records[0]).toMatchObject({ record: 'pass', report: { state: 'ran', note: 'plain' } });
    expect(records[0]).not.toHaveProperty('reportTruncated');
    expect(records[1]).toMatchObject({ lastReport: { state: 'ran', note: 'plain' } });
  });

  it('the real tick path streams each pass through the injected steps', async () => {
    const clock = fakeClock();
    const order: string[] = [];
    const stub = (name: SelfTickStepName): SelfTickStep => async () => {
      order.push(name);
      return { exitCode: 0, output: JSON.stringify({ ok: name }) };
    };
    const steps = {
      'claude-quota': stub('claude-quota'),
      'reset-release': stub('reset-release'),
      'lane-autohold': stub('lane-autohold'),
      'planner-tick': stub('planner-tick'),
    };
    const { code, records } = await run(
      ['--stream', '--apply', '--duration-ms', '1500', '--interval-ms', '1000', '--runs-dir', runsDir],
      { steps, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(order).toHaveLength(8); // two full real passes
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ record: 'pass', pass: 1, exitCode: 0, state: 'ran' });
    expect(records[0]!['report']).toMatchObject({ mode: 'apply', state: 'ran' });
    expect(records[0]!['reportTruncated']).toBeUndefined();
    expect(records[2]).toMatchObject({ ticks: 2, termination: 'duration' });
  });

  it('a throwing stream sink terminates admission safely and still cleans up signals', async () => {
    const clock = fakeClock();
    let removed = 0;
    let ticks = 0;
    const lines: string[] = [];
    const code = await cmdFleetSelfLoop(['--stream', '--duration-ms', '2500', '--interval-ms', '1000'], {
      tick: async () => { ticks += 1; return { exitCode: 0, report: { state: 'ran' } }; },
      now: clock.now, sleep: clock.sleep,
      output: (t) => { if (t.includes('"record":"pass"')) throw new Error('sink gone'); lines.push(t); },
      error: () => {},
      onSignal: () => () => { removed += 1; },
    });
    expect(code).toBe(1);
    expect(ticks).toBe(1); // no second pass after the sink died mid-pass-1
    expect(removed).toBe(1);
    expect(lines).toHaveLength(1); // and it is the single final summary
    const final = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(final['record']).toBe('summary');
    expect(final).toMatchObject(
      { ticks: 1, termination: 'observer-error', observerError: 'sink gone' });
  });

  it('--stream and --json are mutually exclusive and rejected before any pass', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks += 1; return { exitCode: 0, report: null }; };
    for (const args of [
      ['--stream', '--json'], ['--json', '--stream'],
      ['--stream', '--stream'],
    ].map((a) => [...a, '--duration-ms', '1000'])) {
      const { code, stderr } = await run(args, { tick, now: fakeClock().now });
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('--stream');
    }
    expect(ticks).toBe(0);
    const { code, lines } = await run(['--help']);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('[--json | --stream]');
  });

  it('without --stream the output is unchanged: no pass records ever appear', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> => ({ exitCode: 0, report: { state: 'ran' } });
    const json = await run(['--json', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(json.code).toBe(0);
    expect(json.lines).toHaveLength(1);
    const summary = JSON.parse(json.lines[0]!) as Record<string, unknown>;
    expect(summary).toMatchObject({ ticks: 3, termination: 'duration' });
    expect(summary).not.toHaveProperty('record');
    expect(summary).not.toHaveProperty('observerError');
    const humanClock = fakeClock();
    const human = await run(['--duration-ms', '100'],
      { tick, now: humanClock.now, sleep: humanClock.sleep });
    expect(human.code).toBe(0);
    expect(human.lines).toHaveLength(1);
    expect(human.lines[0]).toContain('fleet self-loop: DONE — ticks=1 failed=0 busy=0 (dry-run)');
  });
});
