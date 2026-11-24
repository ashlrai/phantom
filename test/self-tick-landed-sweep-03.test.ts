import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast, SELF_TICK_LAST } from '../src/core/fleet/self-tick-last.js';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { cmdFleetLandedSweep } from '../src/cli/fleet-landed-sweep.js';

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
    'stray-stop': ok('stray-stop', {}),
    'meter-incident': ok('meter-incident', {}),
    'planner-tick': ok('planner-tick', {}),
    'inbox-acks': ok('inbox-acks', {}),
    'owner-live': ok('owner-live', {}),
    'waste-incident': ok('waste-incident', {}),
    'order-notices': ok('order-notices', {}),
    'needs-triage': ok('needs-triage', {}),
    'teammate-overdue': ok('teammate-overdue', {}),
    'landed-sweep': ok('landed-sweep', { v: 1, closed: 1, planned: 2 }),
    'cos-work': ok('cos-work', {}),
    'board-notify': ok('board-notify', {}),
    'recheck-record': ok('recheck-record', {}),
    ...over,
  };
}

describe('self-tick landed-sweep step', () => {
  it.each([false, true])('preserves an unavailable sweep as skipped through CLI and storage (json=%s)', async (json) => {
    const runsDir = tmp();
    const out: string[] = [];
    const calls: string[] = [];
    const code = await cmdFleetSelfTick(['--runs-dir', runsDir, ...(json ? ['--json'] : [])], {
      now: () => 1_000, output: text => out.push(text),
      steps: steps(calls, {
        'landed-sweep': async argv => {
          let output = '';
          const exitCode = await cmdFleetLandedSweep(argv, {
            gh: async () => ({ ok: false, stdout: '', stderr: 'offline' }),
            landedFromGit: () => ({ schema: 'fleet.landed.v1', source: 'git', ok: false, repo: 'phantom', sinceHours: 24, jobs: [], repos: [], reason: 'offline' }),
            output: text => { output = text; },
          });
          return { exitCode, output };
        },
      }),
    });
    expect(code).toBe(0);
    expect(calls.at(-1)).toBe('cos-work');
    const stored = JSON.parse(readFileSync(join(runsDir, SELF_TICK_LAST), 'utf8'));
    const sweep = stored.steps.find((step: { step: string }) => step.step === 'landed-sweep');
    expect(sweep).toMatchObject({ state: 'skipped', exitCode: 0, report: { skippedReason: expect.stringContaining('no landed report yet') } });
    expect(readSelfTickLast(runsDir, 61_000)).toMatchObject({ state: 'ok', failedSteps: [] });
    if (json) expect(JSON.parse(out[0]!).steps).toContainEqual(sweep);
    else expect(out[0]).toContain('landed-sweep  skipped  exit=0  "skipped: no landed report yet');
  });

  it.each([
    [0, { skipped: 1 }, 'ok'],
    [0, { skippedReason: '' }, 'ok'],
    [0, { skippedReason: '   ' }, 'ok'],
    [0, { skippedReason: 1 }, 'ok'],
    [1, { skippedReason: 'offline' }, 'failed'],
  ])('classifies exit=%s with report %j as %s', async (code, sweep, state) => {
    const { report, exitCode } = await runSelfTick({
      runsDir: tmp(), now: () => 0,
      steps: steps([], { 'landed-sweep': async () => ({ exitCode: code, output: JSON.stringify(sweep) }) }),
    });
    expect(report.steps.find(step => step.step === 'landed-sweep')?.state).toBe(state);
    expect(exitCode).toBe(code);
  });

  it('runs every step in order with landed-sweep immediately before cos-work', async () => {
    const calls: string[] = [];
    const { report, exitCode } = await runSelfTick({ runsDir: tmp(), steps: steps(calls), now: () => 0 });
    const order = ['reset-release', 'lane-autohold', 'stray-stop', 'meter-incident', 'planner-tick', 'inbox-acks', 'owner-live', 'order-notices', 'board-notify', 'recheck-record', 'needs-triage', 'waste-incident', 'teammate-overdue', 'landed-sweep', 'cos-work'];
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
      ['reset-release', 'ok'], ['lane-autohold', 'ok'], ['stray-stop', 'ok'], ['meter-incident', 'ok'], ['planner-tick', 'ok'], ['inbox-acks', 'ok'], ['owner-live', 'ok'], ['order-notices', 'ok'], ['board-notify', 'ok'], ['recheck-record', 'ok'], ['needs-triage', 'ok'], ['waste-incident', 'ok'], ['teammate-overdue', 'ok'], ['landed-sweep', 'failed'], ['cos-work', 'ok'],
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
