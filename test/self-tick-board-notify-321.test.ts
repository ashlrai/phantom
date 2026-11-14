import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';

let home: string;
let runsDir: string;
let busRoot: string;
const now = () => Date.parse('2026-11-13T12:00:00Z');
const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
const others: Omit<SelfTickSteps, 'board-notify'> = Object.fromEntries(
  SELF_TICK_STEP_ORDER.filter(n => n !== 'board-notify').map(n => [n, ok]),
) as Omit<SelfTickSteps, 'board-notify'>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'board-notify-321-'));
  runsDir = join(home, 'runs');
  busRoot = join(home, 'bus');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(busRoot, { recursive: true });
  vi.stubEnv('ASHLR_RUNS_DIR', join(home, 'notify-runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('orders board-notify immediately after order-notices', () => {
  expect(SELF_TICK_STEP_ORDER.indexOf('board-notify')).toBe(SELF_TICK_STEP_ORDER.indexOf('order-notices') + 1);
});

it('passes --dry-run and --json, never --runs-dir, unless --apply', async () => {
  const seen: string[][] = [];
  for (const apply of [false, true]) {
    const boardNotify = vi.fn(async (argv: string[]) => { seen.push(argv); return 0; });
    expect(await cmdFleetSelfTick(['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])], {
      home, now, steps: others, boardNotify, busRoot, output: () => {},
    })).toBe(0);
  }
  expect(seen[0]).toEqual(expect.arrayContaining(['--json', '--dry-run', '--root', busRoot]));
  expect(seen[1]).toContain('--json');
  expect(seen[1]).not.toContain('--dry-run');
  for (const argv of seen) expect(argv).not.toContain('--runs-dir');
});

it('omits --root when no busRoot dep is set', async () => {
  const boardNotify = vi.fn(async () => 0);
  await cmdFleetSelfTick(['--json', '--runs-dir', runsDir], { home, now, steps: others, boardNotify, output: () => {} });
  expect(boardNotify.mock.calls[0]![0]).toEqual(['--json', '--dry-run']);
});

it('records a throwing board-notify as failed and still runs landed-sweep', async () => {
  const sweep = vi.fn(ok);
  const out = await runSelfTick({
    runsDir, now,
    steps: { ...others, 'board-notify': async () => { throw new Error('fake'); }, 'landed-sweep': sweep } as SelfTickSteps,
  });
  expect(out.exitCode).toBe(1);
  expect(out.report.steps.find(s => s.step === 'board-notify')).toMatchObject({ state: 'failed', exitCode: 1 });
  expect(sweep).toHaveBeenCalledOnce();
});

it('does not fail the pass when board-notify is not configured', async () => {
  const out = await runSelfTick({ runsDir, now, steps: others as SelfTickSteps });
  expect(out.exitCode).toBe(0);
  expect(out.report.steps.find(s => s.step === 'board-notify')).toEqual({
    step: 'board-notify', state: 'ok', exitCode: 0, report: { reason: 'step-not-configured' },
  });
});

it('runs the real verb in dry-run against temp dirs and writes no state', async () => {
  const lines: string[] = [];
  expect(await cmdFleetSelfTick(['--runs-dir', runsDir], {
    home, now, steps: others, busRoot, output: text => lines.push(text),
  })).toBe(0);
  const line = lines.join('\n').split('\n').find(l => l.includes('board-notify'));
  expect(line).toContain('ok');
  expect(line).toContain('sent=0 planned=0');
  expect(existsSync(join(home, 'notify-runs', 'work-board-notify'))).toBe(false);
});
