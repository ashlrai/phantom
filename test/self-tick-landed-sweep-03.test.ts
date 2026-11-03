import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast } from '../src/core/fleet/self-tick-last.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'self-tick-sweep-')); dirs.push(d); return d; };

function steps(calls: string[], over: Partial<SelfTickSteps> = {}): SelfTickSteps {
  const ok = (name: string, report: unknown): SelfTickStep => async () => {
    calls.push(name); return { exitCode: 0, output: JSON.stringify(report) };
  };
  return {
    'reset-release': ok('reset-release', {}),
    'lane-autohold': ok('lane-autohold', {}),
    'planner-tick': ok('planner-tick', {}),
    'landed-sweep': ok('landed-sweep', { v: 1, closed: 1, planned: 2 }),
    ...over,
  };
}

describe('self-tick landed-sweep step', () => {
  it('runs four steps in order with landed-sweep last', async () => {
    const calls: string[] = [];
    const { report, exitCode } = await runSelfTick({ runsDir: tmp(), steps: steps(calls), now: () => 0 });
    const order = ['reset-release', 'lane-autohold', 'planner-tick', 'landed-sweep'];
    expect([...SELF_TICK_STEP_ORDER]).toEqual(order);
    expect(calls).toEqual(order);
    expect(report.steps.map(s => [s.step, s.state])).toEqual(order.map(n => [n, 'ok']));
    expect(exitCode).toBe(0);
  });

  it('a throwing landed-sweep fails alone', async () => {
    const calls: string[] = [];
    const { report, exitCode } = await runSelfTick({
      runsDir: tmp(), now: () => 0,
      steps: steps(calls, { 'landed-sweep': async () => { throw new Error('boom'); } }),
    });
    expect(report.steps.map(s => [s.step, s.state])).toEqual([
      ['reset-release', 'ok'], ['lane-autohold', 'ok'], ['planner-tick', 'ok'], ['landed-sweep', 'failed'],
    ]);
    expect(exitCode).toBe(1);
  });

  it('a recorded run with the new step reads back through self-tick-last', async () => {
    const runsDir = tmp();
    await runSelfTick({ runsDir, steps: steps([]), now: () => 1_000 });
    const view = readSelfTickLast(runsDir, 61_000);
    expect(view).toMatchObject({ state: 'ok', failedSteps: [] });
    const failedDir = tmp();
    await runSelfTick({
      runsDir: failedDir, now: () => 1_000,
      steps: steps([], { 'landed-sweep': async () => ({ exitCode: 1, output: '' }) }),
    });
    expect(readSelfTickLast(failedDir, 61_000)).toMatchObject({ failedSteps: ['landed-sweep'] });
  });
});
