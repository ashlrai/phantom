import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAdmission } from '../src/cli/admission.js';
import { cmdPool } from '../src/cli/pool.js';
import { adaptiveSettle, recentLaunches, type SettleInputs } from '../src/core/queue/adaptive-settle.js';
import { evaluateAdmission, readAdmission } from '../src/core/queue/admission.js';

const idle: SettleInputs = { load1: 7.2, ncpu: 18, memoryFreePercent: 53, swapGrowthGb: 0, runningJobs: 4, launchesLast10Minutes: 2 };
const now = Date.parse('2026-11-17T12:00:00Z');
const event = (offset: number, job = 'A') => JSON.stringify({ event: 'launch', job, ts: new Date(now + offset).toISOString() });

describe('adaptive launch settle', () => {
  it.each([
    ['idle', {}, 30], ['busy', { load1: 27 }, 165], ['saturated', { load1: 36 }, 300],
    ['memory-tight', { memoryFreePercent: 15 }, 300], ['memory-warning', { memoryFreePercent: 25 }, 165],
    ['swap-growing', { swapGrowthGb: 0.001 }, 300], ['burst', { launchesLast10Minutes: 12 }, 300],
    ['many-running', { runningJobs: 27 }, 165],
  ] as [string, Partial<SettleInputs>, number][])('%s', (_name, patch, expected) => {
    expect(adaptiveSettle({ ...idle, ...patch }).settleSeconds).toBe(expected);
  });
  it('is pure and monotone across CPU, memory, running and launch pressure', () => {
    for (const field of ['load1', 'memoryFreePercent', 'runningJobs', 'launchesLast10Minutes'] as const) {
      let previous = 30;
      for (let i = 0; i <= 100; i++) {
        const value = field === 'memoryFreePercent' ? 100 - i : i;
        const wait = adaptiveSettle({ ...idle, [field]: value }).settleSeconds;
        expect(wait).toBeGreaterThanOrEqual(previous); expect(wait).toBeLessThanOrEqual(300); previous = wait;
      }
    }
    expect(adaptiveSettle(Object.freeze(idle))).toEqual(adaptiveSettle(idle));
  });
  it.each([225, 300, 450])('keeps the %ss legacy floor for swap growth and config off', legacySeconds => {
    expect(adaptiveSettle({ ...idle, swapGrowthGb: 0.1 }, { legacySeconds }).settleSeconds).toBe(legacySeconds);
    expect(adaptiveSettle(idle, { enabled: false, legacySeconds }).settleSeconds).toBe(legacySeconds);
  });
  it('keeps unknown or invalid input visible and conservative', () => {
    for (const key of Object.keys(idle) as (keyof SettleInputs)[]) {
      for (const value of [null, NaN, Infinity, -1]) {
        const result = adaptiveSettle({ ...idle, [key]: value });
        expect(result.settleSeconds).toBe(300); expect(result.inputs[key]).toBeNull();
      }
    }
    for (const patch of [{ ncpu: 0 }, { ncpu: 1.5 }, { runningJobs: 2.5 }, { memoryFreePercent: 101 }]) {
      expect(adaptiveSettle({ ...idle, ...patch }).settleSeconds).toBe(300);
    }
    expect(adaptiveSettle(idle, { legacySeconds: NaN }).legacySeconds).toBe(300);
  });
  it('extends the existing admission evaluation without overriding its blockers', () => {
    const result = evaluateAdmission({ load1: 7, ncpu: 18, procs: 100, worktrees: 1, daemonTickAgeS: 0,
      slots: { lane: { target: 2 } }, running: 2, holder: null, settleInputs: idle });
    expect(result).toMatchObject({ admit: false, settle: { settleSeconds: 30 } });
    expect(result.reason).toContain('at_cap');
  });
  it('counts the open-left ten-minute window, deduplicates, and refuses incomplete tails', () => {
    const lines = [event(-600_000), event(-599_999), event(-599_999), event(0, 'B')].join('\n');
    expect(recentLaunches(lines, true, now)).toBe(2);
    expect(recentLaunches(event(-1), true, now)).toBeNull();
    expect(recentLaunches('', false, now)).toBe(0);
    for (const bad of [null, 'bad', event(1)]) expect(recentLaunches(bad, false, now)).toBeNull();
    expect(recentLaunches(`${event(0)}\n${event(-1)}`, true, now)).toBeNull();
    expect(recentLaunches(`${event(0)}\n${event(-1)}`, false, now)).toBe(2);
    const reconciled = `${event(-1)}\n${JSON.stringify({ event: 'outcome', ts: new Date(now - 3600_000).toISOString() })}`;
    expect(recentLaunches(reconciled, false, now)).toBe(1); expect(recentLaunches(reconciled, true, now)).toBeNull();
    expect(adaptiveSettle({ ...idle, load1: 100 }, { legacySeconds: 225.5 }).settleSeconds).toBe(225.5);
  });
  it('reads launch rows across the jobs-ledger field dialect', () => {
    const dialect = [
      JSON.stringify({ type: 'launch', job_id: 'A', timestamp: new Date(now - 1000).toISOString() }),
      JSON.stringify({ kind: 'launch', jobId: 'B', at: new Date(now - 2000).toISOString() }),
      JSON.stringify({ outcome: 'MERGED', job: 'C', recordedAt: new Date(now - 3000).toISOString() }),
    ].join('\n');
    expect(recentLaunches(dialect, false, now)).toBe(2);
  });
});

describe('admission explain integration', () => {
  let root: string;
  const snapshot = () => ({ schema: 'dispatchd.admission.v2', ts: new Date(now).toISOString(), admit: false,
    reason: 'paused', load1: 7.2, ncpu: 18, running: 4, swap_gb: 1, swap_growth_gb: 0,
    swap_samples: [[now / 1000 - 60, 1], [now / 1000, 1]], privatePayload: 'must-not-escape' });
  const save = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value));
  const options = () => ({ runsDir: root, now: () => now });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adaptive-settle-'));
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await save('queue/admission.json', snapshot());
    await save('queue/status.json', { last_tick: new Date(now).toISOString(), mem_free_pct: 53 });
    await writeFile(join(root, 'metrics/jobs.jsonl'), `${event(-300_000)}\n${event(-60_000, 'B')}\n`);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  it('prints stable JSON and text through the same policy used by pool admission', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const original = await readFile(join(root, 'queue/admission.json'), 'utf8');
    expect(await cmdAdmission(['explain', '--json'], options())).toBe(0);
    const first = String(out.mock.calls.at(-1)![0]);
    expect(JSON.parse(first)).toEqual({ schema: 'phantom.admission-explain.v1', readOnly: true, enforced: false, ...adaptiveSettle(idle) });
    await cmdAdmission(['explain', '--json'], options()); expect(out.mock.calls.at(-1)![0]).toBe(first);
    await cmdAdmission(['explain'], options()); expect(out.mock.calls.at(-1)![0]).toContain('Launch settle: 30s');
    await cmdPool(['admission', '--json'], options());
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toMatchObject({ admit: false, reason: 'paused', settle: adaptiveSettle(idle) });
    expect(first).not.toContain('must-not-escape'); expect(await readFile(join(root, 'queue/admission.json'), 'utf8')).toBe(original);
  });
  it('keeps old pacing for stale/future observations, unmeasured swap, and missing history', async () => {
    for (const patch of [{ ts: new Date(now - 60_001).toISOString() }, { ts: new Date(now + 1).toISOString() }, { swap_samples: [] }, { swap_gb: null }]) {
      await save('queue/admission.json', { ...snapshot(), ...patch });
      expect((await readAdmission(options())).settle.settleSeconds).toBe(300);
    }
    await save('queue/admission.json', snapshot());
    await save('queue/status.json', { last_tick: new Date(now - 60_001).toISOString(), mem_free_pct: 53 });
    expect((await readAdmission(options())).settle.inputs.memoryFreePercent).toBeNull();
    await rm(join(root, 'metrics/jobs.jsonl'));
    expect((await readAdmission(options())).settle.inputs.launchesLast10Minutes).toBeNull();
    expect((await readAdmission({ ...options(), settleConfig: { enabled: false, legacySeconds: 225 } })).settle.settleSeconds).toBe(225);
  });
  it.skipIf(process.platform === 'win32')('does not block on a non-regular history file', async () => {
    const path = join(root, 'metrics/jobs.jsonl'); await rm(path); execFileSync('mkfifo', [path]);
    expect((await readAdmission(options())).settle.inputs.launchesLast10Minutes).toBeNull();
  });
  it('help and invalid arguments do not read host state', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { now: () => { throw new Error('must not read'); } };
    for (const args of [['--help'], ['explain', '--help']]) expect(await cmdAdmission(args, deps)).toBe(0);
    for (const args of [[], ['explain', '--json', '--json'], ['explain', '--bad'], ['run']]) expect(await cmdAdmission(args, deps)).toBe(2);
  });
});
