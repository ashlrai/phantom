/**
 * RQ-PHX-SELFTICKINCIDENTS08 — the self-tick pass raises the meter-flat and
 * waste-high incidents itself: 'meter-incident' and 'waste-incident' run as
 * the sixth and seventh steps, after order-notices and before landed-sweep,
 * so the desktop Needs-you rows and the phone see them without anyone asking.
 * Every step but the one under test is an injected fake; the real
 * waste-incident path proves the --json capture seam works end to end.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickStepName, type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';
import { readSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import type { WasteRiskInput } from '../src/core/resources/waste-risk.js';

const ORDER: SelfTickStepName[] = [
  'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices',
  'meter-incident', 'waste-incident', 'landed-sweep',
];

let home: string;
let runsDir: string;
const now = () => Date.parse('2026-11-02T06:00:00Z');
const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'self-tick-incidents-08-'));
  runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Recording fakes for every step; order[] proves the pass ran them in order. */
const recording = () => {
  const order: SelfTickStepName[] = [];
  const argvs: Partial<Record<SelfTickStepName, string[]>> = {};
  const steps: SelfTickSteps = Object.fromEntries(ORDER.map(name => [name, async (argv: string[]) => {
    order.push(name);
    argvs[name] = [...argv];
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  }])) as SelfTickSteps;
  return { order, argvs, steps };
};

const run = (args: string[], deps: Parameters<typeof cmdFleetSelfTick>[1] = {}) => {
  const out: string[] = [];
  return cmdFleetSelfTick(args, {
    home, now, ...deps,
    output: text => out.push(text), error: () => {},
  }).then(code => ({
    code,
    report: out[0]?.startsWith('{') ? JSON.parse(out[0]) as {
      mode: string; state: string;
      steps: { step: string; state: string; exitCode: number; report: unknown }[];
    } : null,
  }));
};

it('runs the two incident steps after order-notices and before landed-sweep', async () => {
  expect([...SELF_TICK_STEP_ORDER]).toEqual(ORDER);
  const rec = recording();
  const { code, report } = await run(['--json', '--runs-dir', runsDir], { steps: rec.steps });
  expect(code).toBe(0);
  expect(rec.order).toEqual(ORDER);
  expect(report!.steps.map(s => s.step)).toEqual(ORDER);
});

it('forwards --apply and --runs-dir to the incident steps only on apply ticks', async () => {
  for (const apply of [true, false]) {
    const rec = recording();
    const { code } = await run(
      ['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], { steps: rec.steps });
    expect(code).toBe(0);
    for (const name of ['meter-incident', 'waste-incident'] as const) {
      const argv = rec.argvs[name]!;
      expect(argv).toEqual(expect.arrayContaining(['--json', '--runs-dir', runsDir]));
      expect(argv.includes('--apply')).toBe(apply);
    }
  }
});

it('records a throwing waste-incident step as failed and still runs landed-sweep', async () => {
  const sweep = vi.fn(ok);
  const { code, report } = await run(['--apply', '--json', '--runs-dir', runsDir], {
    steps: {
      ...recording().steps,
      'waste-incident': async () => { throw new Error('fake failure'); },
      'landed-sweep': sweep,
    },
  });
  expect(code).toBe(1);
  expect(sweep).toHaveBeenCalledOnce();
  expect(report!.steps.find(s => s.step === 'waste-incident'))
    .toMatchObject({ state: 'failed', exitCode: 1, report: null });
  expect(report!.steps.find(s => s.step === 'landed-sweep')).toMatchObject({ state: 'ok' });
  expect(readSelfTickLast(runsDir, now()))
    .toMatchObject({ state: 'ok', failedSteps: ['waste-incident'] });
});

it('the real waste-incident step lands a parseable fleet.waste-incident.v1 report', async () => {
  // One 'high' row: 86 of a 100-unit allowance projected unused with ~5% of
  // the window left at reset — enough for planWasteIncidents to plan an incident.
  const input: WasteRiskInput = {
    lane: 'devin', used: 10, limit: 100,
    window_start: '2026-10-26T00:00:00Z', reset_at: '2026-11-02T14:00:00Z',
    now: new Date(now()).toISOString(), burn_per_hour: 0.5,
    running: 1, per_job_cost: null, ceiling: 2,
  };
  const others = recording().steps;
  const { 'waste-incident': _dropped, ...fakes } = others;
  const { code, report } = await run(['--json', '--runs-dir', runsDir], {
    steps: fakes,
    wasteRead: async () => [input],
  });
  expect(code).toBe(0);
  const step = report!.steps.find(s => s.step === 'waste-incident')!;
  expect(step.state).toBe('ok');
  const wasteReport = step.report as {
    schema: string; planned: { kind: string; lane: string }[]; posted: unknown;
  };
  expect(wasteReport.schema).toBe('fleet.waste-incident.v1');
  // Dry run: the incident is planned but nothing is posted to the bus.
  expect(wasteReport.planned).toHaveLength(1);
  expect(wasteReport.planned[0]).toMatchObject({ kind: 'waste-high', lane: 'devin' });
  expect(wasteReport.posted).toBeNull();
});
