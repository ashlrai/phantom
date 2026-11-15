/**
 * RQ-PHX-SELFTICKRECHECKREC328 — the self-tick pass appends the read-only
 * fleet recheck verdict to the retained recheck log through the real
 * cmdFleetRecheckRecord wiring, placed directly after board-notify. A dry
 * run records nothing and never calls the verb, a failed record marks only
 * its own step, and an unconfigured step reports ok/step-not-configured
 * like board-notify.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';

let home: string;
let runsDir: string;
const now = () => Date.parse('2026-11-14T12:00:00Z');
const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
const others: Omit<SelfTickSteps, 'recheck-record'> = Object.fromEntries(
  SELF_TICK_STEP_ORDER.filter(n => n !== 'recheck-record').map(n => [n, ok]),
) as Omit<SelfTickSteps, 'recheck-record'>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recheck-record-328-'));
  runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

interface TickReport {
  steps: { step: string; state: string; exitCode: number; report: unknown }[];
}
const tick = async (args: string[], deps: Parameters<typeof cmdFleetSelfTick>[1]) => {
  let text = '';
  const code = await cmdFleetSelfTick(args, { home, now, ...deps, output: t => { text = t; } });
  return { code, report: JSON.parse(text) as TickReport };
};
const step = (report: TickReport, name: string) => report.steps.find(s => s.step === name);

it('orders recheck-record immediately after board-notify and before needs-triage', () => {
  expect(SELF_TICK_STEP_ORDER.indexOf('recheck-record'))
    .toBe(SELF_TICK_STEP_ORDER.indexOf('board-notify') + 1);
  expect(SELF_TICK_STEP_ORDER.indexOf('needs-triage'))
    .toBe(SELF_TICK_STEP_ORDER.indexOf('recheck-record') + 1);
});

it('dry-run never calls the seam and reports wouldRecord', async () => {
  const recheckRecord = vi.fn(async () => 0);
  const { code, report } = await tick(['--json', '--runs-dir', runsDir], { steps: others, recheckRecord });
  expect(code).toBe(0);
  expect(recheckRecord).not.toHaveBeenCalled();
  expect(step(report, 'recheck-record')).toMatchObject({
    state: 'ok', exitCode: 0, report: { reason: 'dry-run', wouldRecord: true },
  });
});

it('--apply calls the seam once with no argv and reports its captured line', async () => {
  const recheckRecord = vi.fn(async () => {
    console.log('recorded VERIFIED as-of=2026-11-14T12:00:00Z');
    return 0;
  });
  const { code, report } = await tick(['--json', '--apply', '--runs-dir', runsDir], { steps: others, recheckRecord });
  expect(code).toBe(0);
  expect(recheckRecord).toHaveBeenCalledOnce();
  // The shared self-tick argv (--json/--apply/--runs-dir) never reaches the verb.
  expect(recheckRecord.mock.calls[0]).toEqual([]);
  expect(step(report, 'recheck-record')).toMatchObject({
    state: 'ok', exitCode: 0,
    report: { recorded: 'recorded VERIFIED as-of=2026-11-14T12:00:00Z' },
  });
});

it('an apply tick on a custom runs dir skips the real verb instead of writing operator state', async () => {
  const { code, report } = await tick(['--json', '--apply', '--runs-dir', runsDir], { steps: others });
  expect(code).toBe(0);
  expect(step(report, 'recheck-record')).toMatchObject({
    state: 'ok', exitCode: 0,
    report: { reason: 'custom-runs-dir-no-recheck-root', wouldRecord: true },
  });
});

it('a failing seam marks only recheck-record failed and landed-sweep still runs', async () => {
  const recheckRecord = vi.fn(async () => 1);
  const sweep = vi.fn(ok);
  const { code, report } = await tick(['--json', '--apply', '--runs-dir', runsDir], {
    steps: { ...others, 'landed-sweep': sweep }, recheckRecord,
  });
  expect(code).toBe(1);
  expect(report.steps.filter(s => s.state === 'failed').map(s => s.step)).toEqual(['recheck-record']);
  expect(step(report, 'recheck-record')).toMatchObject({ state: 'failed', exitCode: 1 });
  expect(sweep).toHaveBeenCalledOnce();
});

it('an unconfigured recheck-record reports ok with step-not-configured', async () => {
  const out = await runSelfTick({ runsDir, now, steps: others as SelfTickSteps });
  expect(out.exitCode).toBe(0);
  expect(out.report.steps.find(s => s.step === 'recheck-record')).toEqual({
    step: 'recheck-record', state: 'ok', exitCode: 0, report: { reason: 'step-not-configured' },
  });
});
