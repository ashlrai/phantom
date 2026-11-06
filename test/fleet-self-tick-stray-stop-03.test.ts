import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast, writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'self-tick-stray-')); dirs.push(d); return d; };

const NAMES = ['reset-release', 'lane-autohold', 'stray-stop', 'planner-tick', 'inbox-acks', 'order-notices', 'landed-sweep'] as const;

function fakeSteps(calls: Array<[string, string[]]>, over: Partial<SelfTickSteps> = {}): SelfTickSteps {
  const ok = (name: string): SelfTickStep => async (argv) => {
    calls.push([name, argv]);
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  };
  const all = Object.fromEntries(NAMES.map((n) => [n, ok(n)])) as unknown as SelfTickSteps;
  return { ...all, ...over };
}

describe('self-tick stray-stop step', () => {
  it('sits directly before planner-tick so freed slots count for the planner', () => {
    const order = [...SELF_TICK_STEP_ORDER];
    expect(order).toEqual([...NAMES]);
    expect(order.indexOf('stray-stop')).toBe(order.indexOf('planner-tick') - 1);
  });

  it('runs before planner-tick and receives --apply only in apply mode', async () => {
    for (const apply of [false, true]) {
      const calls: Array<[string, string[]]> = [];
      const runsDir = tmp();
      const { report, exitCode } = await runSelfTick({ runsDir, apply, steps: fakeSteps(calls), now: () => 0 });
      expect(exitCode).toBe(0);
      expect(calls.map(([name]) => name)).toEqual([...NAMES]);
      const stray = calls.find(([name]) => name === 'stray-stop')![1];
      expect(stray).toEqual(['--json', ...(apply ? ['--apply'] : []), '--runs-dir', runsDir]);
      expect(report.steps.map((s) => s.step)).toEqual([...NAMES]);
    }
  });

  it('records a failed stray-stop and still runs planner-tick', async () => {
    const calls: Array<[string, string[]]> = [];
    const failing: SelfTickStep = async () => ({ exitCode: 1, output: '' });
    const { report, exitCode } = await runSelfTick({
      runsDir: tmp(), steps: fakeSteps(calls, { 'stray-stop': failing }), now: () => 0,
    });
    expect(exitCode).toBe(1);
    expect(report.steps.find((s) => s.step === 'stray-stop')).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(calls.map(([name]) => name)).toContain('planner-tick');
    const thrown = await runSelfTick({
      runsDir: tmp(), steps: fakeSteps([], { 'stray-stop': async () => { throw new Error('boom'); } }), now: () => 0,
    });
    expect(thrown.report.steps.find((s) => s.step === 'stray-stop')).toMatchObject({ state: 'failed', exitCode: 1, report: null });
    expect(thrown.report.steps.find((s) => s.step === 'planner-tick')?.state).toBe('ok');
  });

  it('skips an unbound stray-stop seam for embedders that predate it', async () => {
    const calls: Array<[string, string[]]> = [];
    const steps = fakeSteps(calls);
    delete steps['stray-stop'];
    const { report, exitCode } = await runSelfTick({ runsDir: tmp(), steps, now: () => 0 });
    expect(exitCode).toBe(0);
    expect(report.steps.map((s) => s.step)).not.toContain('stray-stop');
  });

  it('a recorded run containing stray-stop reads back through self-tick-last', async () => {
    const runsDir = tmp();
    const { report } = await runSelfTick({
      runsDir, steps: fakeSteps([]), now: () => 0, writeLast: () => undefined,
    });
    writeSelfTickLast(runsDir, report);
    const view = readSelfTickLast(runsDir, 1000);
    expect(view).not.toBeNull();
    expect(view?.state).not.toBe('unreadable');
  });

  it('the CLI binding passes --max 5 and keeps a dry run a dry run', async () => {
    for (const apply of [false, true]) {
      const runsDir = tmp();
      const killed: number[] = [];
      const strays = Array.from({ length: 8 }, (_, i) => ({ job: `RQ-${i}`, pid: 987600 + i, ageSeconds: 60 }));
      const out: string[] = [];
      const noop = (name: string): SelfTickStep => async () => ({ exitCode: 0, output: JSON.stringify({ ok: name }) });
      const code = await cmdFleetSelfTick(['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
        home: runsDir,
        output: (text) => out.push(text),
        error: () => undefined,
        steps: {
          'reset-release': noop('reset-release'), 'lane-autohold': noop('lane-autohold'),
          'planner-tick': noop('planner-tick'), 'inbox-acks': noop('inbox-acks'),
          'order-notices': noop('order-notices'), 'landed-sweep': noop('landed-sweep'),
        },
        strayStop: {
          readStraySlots: async () => ({ lanes: [{ lane: 'devin', slotsLost: 8, strays }] }),
          kill: (pid) => { killed.push(pid); },
          ledgerFile: join(runsDir, 'stray-stops.jsonl'),
          now: () => new Date('2026-11-03T00:00:00Z'),
        },
      });
      const parsed = JSON.parse(out.join('\n')) as { steps: Array<{ step: string; report: { mode: string; planned: unknown[]; summary: { capped: boolean } } }> };
      const stray = parsed.steps.find((s) => s.step === 'stray-stop')!;
      expect(stray.report.planned).toHaveLength(5);
      expect(stray.report.summary.capped).toBe(true);
      expect(stray.report.mode).toBe(apply ? 'apply' : 'dry-run');
      // Real signals are faked; a dry run sends none and apply sends at most 5.
      expect(killed.length).toBeLessThanOrEqual(apply ? 5 : 0);
      expect(code === 0 || code === 1).toBe(true);
    }
  });
});
