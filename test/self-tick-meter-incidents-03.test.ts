import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-meter-self-tick-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(['ok', 'throw', 'exit-1'])('runs meter incidents in order and continues after %s', async (mode) => {
  const calls: string[] = [];
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(name => [name, async (args: string[]) => {
    calls.push(name);
    expect(args).toEqual(['--json', '--apply', '--runs-dir', runsDir]);
    if (name === 'meter-incidents' && mode === 'throw') throw new Error('fake failure');
    return { exitCode: name === 'meter-incidents' && mode === 'exit-1' ? 1 : 0, output: '{}' };
  }])) as SelfTickSteps;
  const runsDir = temp();
  const result = await runSelfTick({ runsDir, apply: true, steps });
  expect(calls).toEqual([
    'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices', 'meter-incidents', 'landed-sweep',
  ]);
  expect(result.report.steps.at(-2)).toMatchObject({ step: 'meter-incidents', state: mode === 'ok' ? 'ok' : 'failed' });
  expect(result.report.steps.at(-1)).toMatchObject({ step: 'landed-sweep', state: 'ok' });
  expect(result.exitCode).toBe(mode === 'ok' ? 0 : 1);
});
