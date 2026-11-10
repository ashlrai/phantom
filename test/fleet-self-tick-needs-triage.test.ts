import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickStepName, type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';

let home: string;
let runsDir: string;
const now = () => Date.parse('2026-11-09T06:00:00Z');
const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
const allOk = (): SelfTickSteps => Object.fromEntries(SELF_TICK_STEP_ORDER.map(name => [name, ok])) as SelfTickSteps;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'needs-triage-tick-'));
  runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

it('orders needs-triage after order-notices and before landed-sweep', () => {
  const at = (name: SelfTickStepName) => SELF_TICK_STEP_ORDER.indexOf(name);
  expect(at('needs-triage')).toBe(at('order-notices') + 1);
  expect(at('needs-triage')).toBe(at('landed-sweep') - 1);
});

it('runSelfTick passes --json, and --apply only under apply', async () => {
  for (const apply of [true, false]) {
    const triage = vi.fn(ok);
    await runSelfTick({ apply, runsDir: home, now, steps: { ...allOk(), 'needs-triage': triage } });
    expect(triage.mock.calls[0]![0]).toEqual(['--json', ...(apply ? ['--apply'] : []), '--runs-dir', home]);
  }
});

it('records a failing needs-triage step and still runs landed-sweep', async () => {
  const sweep = vi.fn(ok);
  const { report } = await runSelfTick({
    apply: true, runsDir: home, now,
    steps: { ...allOk(), 'needs-triage': async () => ({ exitCode: 1, output: '' }), 'landed-sweep': sweep },
  });
  expect(report.steps.find(s => s.step === 'needs-triage')?.state).toBe('failed');
  expect(sweep).toHaveBeenCalledOnce();
});

const items = [
  { id: 'N1', text: 'unpark RQ-FIXTURE-1', status: 'open' },
  { id: 'N2', text: 'Paste the API key for the fake service', status: 'open' },
];

const runTick = async (apply: boolean) => {
  const resolve = vi.fn(() => ({ ok: true }) as never);
  const out: string[] = [];
  const steps: Partial<SelfTickSteps> = {};
  for (const name of SELF_TICK_STEP_ORDER) if (name !== 'needs-triage') steps[name] = ok;
  const code = await cmdFleetSelfTick(['--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
    home, now, steps, output: text => out.push(text),
    needsTriage: { read: (() => ({ status: 'ok', items })) as never, resolve },
  });
  return { code, resolve, out };
};

it('cmdFleetSelfTick resolves only the auto item under --apply', async () => {
  const { code, resolve, out } = await runTick(true);
  expect(code).toBe(0);
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'N1' }), expect.anything());
  expect(out.join('\n')).toContain('needs-triage  ok');
});

it('cmdFleetSelfTick never resolves without --apply', async () => {
  const { code, resolve, out } = await runTick(false);
  expect(code).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
  expect(out.join('\n')).toContain('auto=1 needs-mason=1');
});
