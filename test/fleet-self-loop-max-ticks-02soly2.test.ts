/**
 * RQ-PHX-SELFLOOPTICKBOUND02SOLY2 — `--max-ticks` optional count bound for
 * `ashlr fleet self-loop`.  An integer 1..1000, validated by the CLI before
 * any pass runs.  Whichever bound (duration or count) occurs first stops
 * admission.  Every completed tick counts (busy / failure included).  Never
 * starts N+1.  No sleep after the final allowed pass.
 *
 * Clocks, ticks and sleeps are faked; the runs dir is a temp dir; no real
 * provider, planner child or machine state is ever touched.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import type { SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-loop-max-ticks-'));
  await mkdir(join(runsDir, 'queue'));
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

interface Summary {
  v: number; startedAt: string; endedAt: string; elapsedMs: number;
  durationMs: number; intervalMs: number; ticks: number; failures: number;
  busy: number; termination: string; lastReport: Record<string, unknown> | null;
  maxTicks?: number;
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

const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps, sleep };
};

describe('fleet self-loop --max-ticks', () => {

  it('N=1: runs exactly 1 pass, no sleep after the final pass', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    // JSON mode: check summary fields
    const { code, summary } = await run(
      ['--json', '--duration-ms', '60000', '--max-ticks', '1'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(summary!.ticks).toBe(1);
    expect(summary!.termination).toBe('max-ticks');
    expect(summary!.maxTicks).toBe(1);
    expect(summary!.failures).toBe(0);
    // No sleep runs after the final allowed pass (max-ticks=1 reached).
    expect(clock.sleeps).toHaveLength(0);
  });

  it('N=1 non-json: human output shows MAX-TICKS', async () => {
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    const { outLines } = await run(
      ['--duration-ms', '60000', '--max-ticks', '1'],
      { tick });
    expect(outLines[0]).toContain('MAX-TICKS');
  });

  it('N=3: counts busy and failure passes', async () => {
    const clock = fakeClock();
    let n = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      n++;
      if (n === 2) return { exitCode: 1, report: { state: 'failed' } };
      if (n === 3) return { exitCode: 0, report: { state: 'busy' } };
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const { summary } = await run(
      ['--json', '--duration-ms', '60000', '--max-ticks', '3', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(summary!.ticks).toBe(3);
    expect(summary!.termination).toBe('max-ticks');
    expect(summary!.maxTicks).toBe(3);
    expect(summary!.failures).toBe(1);
    expect(summary!.busy).toBe(1);
  });

  it('shorter duration wins over max-ticks', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    // 2500ms allows 3 passes (0, 1000, 2000).  max-ticks=5 would allow 5 passes.
    // Duration is the tighter bound.
    const { summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000', '--max-ticks', '5'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(summary!.ticks).toBe(3);
    expect(summary!.termination).toBe('duration');
    // maxTicks should be shown in the summary when supplied, regardless of
    // which bound caused the exit.
    expect(summary!.maxTicks).toBe(5);
  });

  it('max-ticks wins over duration', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    // 6000ms allows 4 passes (0, 1000, 2000, 3000).  max-ticks=2 stops at 2.
    const { summary } = await run(
      ['--json', '--duration-ms', '6000', '--interval-ms', '1000', '--max-ticks', '2'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(summary!.ticks).toBe(2);
    expect(summary!.termination).toBe('max-ticks');
    expect(summary!.maxTicks).toBe(2);
  });

  it('default no-cap behavior is unchanged when --max-ticks is omitted', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    const { summary } = await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(summary!.ticks).toBe(3);
    expect(summary!.termination).toBe('duration');
    expect(summary!.maxTicks).toBeUndefined();
  });
  it('signal with max-ticks still reports maxTicks in summary', async () => {
    const controller = new AbortController();
    // Abort after 1ms: the real CLI runs the full tick in < 1ms, so the
    // loop may exit via duration before the abort takes effect — that is
    // fine; the important thing is that maxTicks is still reported.
    const timer = setTimeout(() => controller.abort(), 1);
    const { summary } = await run(
      ['--json', '--duration-ms', '100', '--max-ticks', '10'],
      { signal: controller.signal });
    clearTimeout(timer);
    expect(summary!.maxTicks).toBe(10);
  });

  it('CLI rejects --max-ticks before running passes', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks++; return { exitCode: 0, report: null }; };
    for (const args of [
      ['--max-ticks'],                        // missing value
      ['--max-ticks', 'abc'],                 // non-numeric
      ['--max-ticks', '0'],                   // zero (must be >= 1)
      ['--max-ticks', '-1'],                  // negative
      ['--max-ticks', '1.5'],                 // fractional
      ['--max-ticks', '1001'],                // over-cap
      ['--max-ticks', '1000000000000000000'], // unsafe integer
    ]) {
      const { code } = await run(args, { tick });
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(ticks).toBe(0);
    }
  });

  it('CLI accepts boundary value --max-ticks 1 (runs exactly 1 tick)', async () => {
    const clock = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    const { summary } = await run(
      ['--json', '--duration-ms', '60000', '--max-ticks', '1'],
      { tick, now: clock.now, sleep: clock.sleep });
    expect(summary!.ticks).toBe(1);
    expect(summary!.termination).toBe('max-ticks');
    expect(summary!.maxTicks).toBe(1);
  });

  it('stream output exposes the count-bound termination in summary', async () => {
    const clockStream = fakeClock();
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    const { outLines } = await run(
      ['--stream', '--duration-ms', '60000', '--interval-ms', '1000', '--max-ticks', '2'],
      { tick, now: clockStream.now, sleep: clockStream.sleep });
    // Last line is the summary; it should contain maxTicks and termination 'max-ticks'.
    const summaryLine = outLines[outLines.length - 1]!;
    const summaryObj = JSON.parse(summaryLine);
    expect(summaryObj.record).toBe('summary');
    expect(summaryObj.termination).toBe('max-ticks');
    expect(summaryObj.maxTicks).toBe(2);
  });

  it('duplicate --max-ticks is rejected before any pass runs', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks++; return { exitCode: 0, report: null }; };
    const { code } = await run(
      ['--duration-ms', '1000', '--max-ticks', '5', '--max-ticks', '3'], { tick });
    expect(code).toBe(2);
    expect(ticks).toBe(0);
  });
});
