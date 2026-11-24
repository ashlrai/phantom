import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetStrayStop } from '../src/cli/fleet-stray-stop.js';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER } from '../src/core/fleet/self-tick.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import type { StraySlotsReport } from '../src/core/fleet/stray-slots.js';

// The daemon's real slots.json shape, plain values: null ceiling, top-level scalars, extra lane fields.
const hostSlots = {
  hard_cap: 32, last_change_by: 'dispatch daemon',
  codex: { target: 4, floor: 1, ceiling: null, held: false, pause_new_until: null, backoff_note: 'none', filler_excluded: false },
  claude: { target: 2, floor: 0, ceiling: 8, held: false, backoff_note: 'steady' },
};
const empty: StraySlotsReport = { lanes: [{ lane: 'codex', slotsLost: 0, strays: [] }] };
let dir: string;
let out: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stray-reason-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify(hostSlots));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const deps = (read: () => Promise<StraySlotsReport>) => ({ readStraySlots: read, kill: vi.fn(), ledgerFile: join(dir, 'stray-stops.jsonl'), now: () => new Date('2026-11-03T00:00:00Z') });

it('reads the host-shaped slots file and reports an ok stray-stop', async () => {
  const lanes = await readLaneTargets({ runsDir: dir });
  expect(lanes.sourceState).toBe('healthy');
  expect(lanes.lanes.map(l => [l.lane, l.ceiling])).toEqual([['codex', null], ['claude', 8]]);
  expect(await cmdFleetStrayStop(['--json'], deps(async () => empty))).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ ok: true, checked: { lanes: 1, strays: 0 }, summary: { planned: 0 } });
});

it('an unreadable evidence source fails with a plain-word reason, never an empty report', async () => {
  const read = async (): Promise<StraySlotsReport> => { throw new Error('jobs ledger is unreadable'); };
  expect(await cmdFleetStrayStop(['--json'], deps(read))).toBe(1);
  const report = JSON.parse(out.at(-1)!);
  expect(report).toMatchObject({ v: 1, ok: false, checked: { lanes: 0, strays: 0 } });
  expect(report.reason).toContain('jobs ledger is unreadable');
  out.length = 0;
  expect(await cmdFleetStrayStop([], deps(read))).toBe(1);
  expect(out.at(-1)).toContain('Stray stop failed: could not read');
});

it('self-tick prints the reason on a failed stray-stop step', async () => {
  const ok = async () => ({ exitCode: 0, output: '{}' });
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, ok]));
  const read = async (): Promise<StraySlotsReport> => { throw new Error('jobs ledger is unreadable'); };
  const others = Object.fromEntries(Object.entries(steps).filter(([name]) => name !== 'stray-stop'));
  expect(await cmdFleetSelfTick(['--runs-dir', dir], { steps: others as never, stray: { readStraySlots: read }, now: () => Date.parse('2026-11-03T00:00:00Z') } as never)).toBe(1);
  const text = out.join('\n');
  expect(text).toMatch(/stray-stop\s+failed\s+exit=1\s+"reason: could not read the process and job evidence: jobs ledger is unreadable/);
  out.length = 0;
  await cmdFleetSelfTick(['--json', '--runs-dir', dir], { steps: others as never, stray: { readStraySlots: read }, now: () => Date.parse('2026-11-03T00:00:00Z') } as never);
  const step = JSON.parse(out.at(-1)!).steps.find((s: { step: string }) => s.step === 'stray-stop');
  expect(step.report).not.toBeNull();
  expect(step.report.ok).toBe(false);
});
