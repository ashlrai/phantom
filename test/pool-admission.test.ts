/**
 * RQ-LOADGATE-1 — `phm pool admission` and the read-only admission core that mirrors dispatchd's load gate.
 * Temp runs dirs and injected probes only; nothing reads the real load, process table, daemon or ~/.ashlr-runs.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdPool } from '../src/cli/pool.js';
import { evaluateAdmission, globalCap, readAdmission, type AdmissionInput } from '../src/core/queue/admission.js';
import { readLaneTargets, setLaneTarget } from '../src/core/fleet/runs-lane-targets.js';
import { releaseLaneHold } from '../src/core/fleet/runs-lane-hold.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const lane = (target: number, extra: Record<string, unknown> = {}) => ({ target, floor: 0, ceiling: 16, held: false, last_change: 0, ...extra });
const healthy = (over: Partial<AdmissionInput> = {}): AdmissionInput => ({
  load1: 1, ncpu: 18, procs: 300, worktrees: 5, daemonTickAgeS: 10, slots: { devin: lane(10), hard_cap: 18 }, running: 2, holder: null, ...over,
});

describe('evaluateAdmission gates', () => {
  it('admits a healthy host', () => {
    const r = evaluateAdmission(healthy());
    expect(r).toMatchObject({ admit: true, reason: null, cap: 10, hardCap: 18, running: 2, ncpu: 18 });
  });
  it('blocks on loadavg over 2 x ncpu', () => {
    const r = evaluateAdmission(healthy({ ncpu: 4, load1: 8.5 }));
    expect(r.admit).toBe(false);
    expect(r.reason).toBe('loadavg 8.5 > 8.0');
    expect(evaluateAdmission(healthy({ ncpu: 4, load1: 8 })).admit).toBe(true);
  });
  it('blocks on loadavg over 36 whatever ncpu is', () => {
    expect(evaluateAdmission(healthy({ ncpu: 64, load1: 36.5 })).reason).toBe('loadavg 36.5 > 36.0');
    expect(evaluateAdmission(healthy({ ncpu: 64, load1: 35.9 })).admit).toBe(true);
  });
  it('fails closed on a NaN load reading', () => {
    expect(evaluateAdmission(healthy({ load1: Number.NaN })).admit).toBe(false);
  });
  it('blocks on more than 800 processes', () => {
    expect(evaluateAdmission(healthy({ procs: 801 })).reason).toBe('procs 801 > 800');
    expect(evaluateAdmission(healthy({ procs: 800 })).admit).toBe(true);
  });
  it('blocks on more than 40 live job worktrees', () => {
    expect(evaluateAdmission(healthy({ worktrees: 41 })).reason).toBe('worktrees 41 > 40');
    expect(evaluateAdmission(healthy({ worktrees: 40 })).admit).toBe(true);
  });
  it('blocks on a daemon tick older than 15 minutes, or an unreadable status', () => {
    expect(evaluateAdmission(healthy({ daemonTickAgeS: 901 })).reason).toBe('daemon_tick_stale 901s > 900s');
    expect(evaluateAdmission(healthy({ daemonTickAgeS: 900 })).admit).toBe(true);
    const gone = evaluateAdmission(healthy({ daemonTickAgeS: null, daemonWhy: 'Error' }));
    expect(gone).toMatchObject({ admit: false, reason: 'daemon_status_unavailable (Error)' });
  });
  it('lists every tripped gate', () => {
    const r = evaluateAdmission(healthy({ load1: 200, procs: 900, worktrees: 50, daemonTickAgeS: 2000 }));
    expect(r.reasons).toHaveLength(4);
  });
  it('reports at_cap once running reaches the cap', () => {
    const r = evaluateAdmission(healthy({ running: 10 }));
    expect(r).toMatchObject({ admit: false, reason: 'at_cap running 10 >= cap 10' });
  });
  it('an owner-disabled gate lists reasons but admits (cap still applies)', () => {
    const r = evaluateAdmission(healthy({ load1: 500, disabled: true }));
    expect(r).toMatchObject({ admit: true, disabled: true, reason: null });
    expect(r.reasons).toHaveLength(1);
    expect(evaluateAdmission(healthy({ load1: 500, disabled: true, running: 10 })).admit).toBe(false);
  });
});

describe('globalCap', () => {
  it('is min(sum of unheld targets, ncpu, hard_cap)', () => {
    expect(globalCap({ a: lane(10), b: lane(10) }, 18).cap).toBe(18);
    expect(globalCap({ a: lane(10), b: lane(10) }, 4).cap).toBe(4);
    expect(globalCap({ a: lane(3), b: lane(2) }, 18).cap).toBe(5);
    expect(globalCap({ a: lane(10), b: lane(10), hard_cap: 7 }, 18)).toEqual({ cap: 7, hardCap: 7 });
  });
  it('skips held lanes, bounds each lane by its own hard_cap, and defaults the global hard_cap to 18', () => {
    expect(globalCap({ a: lane(10, { held: true }), b: lane(4) }, 18).cap).toBe(4);
    expect(globalCap({ a: lane(10, { hard_cap: 3 }), b: lane(4) }, 18).cap).toBe(7);
    expect(globalCap({ a: lane(30, { ceiling: 32 }) }, 64)).toEqual({ cap: 18, hardCap: 18 });
    expect(globalCap({ a: lane(5), hard_cap: -1 }, 18).hardCap).toBe(18);
  });
});

describe('readAdmission and phm pool admission', () => {
  let dir: string; let queue: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pool-admission-'));
    queue = join(dir, 'queue');
    await mkdir(queue, { recursive: true });
    await writeFile(join(queue, 'slots.json'), JSON.stringify({ devin: lane(6), hard_cap: 18 }));
    await writeFile(join(queue, 'status.json'), JSON.stringify({ lanes: { devin: { running: 3 }, claude: { running: 1 } } }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
  const probes = (over = {}) => ({
    runsDir: dir, now: () => NOW, load1: () => 2, ncpu: () => 18, countProcesses: async () => 120,
    daemonLastTickAt: async () => new Date(NOW - 60_000).toISOString(), ...over,
  });

  it('reports load, ncpu, cap, running and an admit verdict from the runs dir', async () => {
    const r = await readAdmission(probes());
    expect(r).toMatchObject({ admit: true, cap: 6, running: 4, ncpu: 18, procs: 120, load: { load1: 2, max: 36 } });
    expect(r.daemon.tickAgeSeconds).toBe(60);
    expect(r.installLock.holder).toBeNull();
  });
  it('counts only .base files whose worktree directory exists', async () => {
    const wt = join(dir, 'wt-1'); await mkdir(wt);
    await writeFile(join(dir, 'RQ-A.base'), `abc x ${wt} devin\n`);
    await writeFile(join(dir, 'RQ-B.base'), `abc x ${join(dir, 'gone')} devin\n`);
    await writeFile(join(dir, 'RQ-C.base'), 'short\n');
    expect((await readAdmission(probes())).worktrees).toBe(1);
  });
  it('trips on each live probe', async () => {
    expect((await readAdmission(probes({ load1: () => 40 }))).reason).toContain('loadavg 40.0 > 36.0');
    expect((await readAdmission(probes({ countProcesses: async () => 1000 }))).reason).toContain('procs 1000 > 800');
    expect((await readAdmission(probes({ daemonLastTickAt: async () => new Date(NOW - 20 * 60_000).toISOString() }))).reason).toContain('daemon_tick_stale 1200s');
    expect((await readAdmission(probes({ daemonLastTickAt: async () => null }))).reason).toContain('daemon_status_unavailable (no lastTickAt)');
    expect((await readAdmission(probes({ daemonLastTickAt: async () => { throw new Error('spawn ashlr ENOENT'); } }))).reason).toContain('daemon_status_unavailable (Error)');
    expect((await readAdmission(probes({ countProcesses: async () => { throw new Error('no ps'); } }))).admit).toBe(false);
  });
  it('reports the install-lock holder only while its pid is alive', async () => {
    await writeFile(join(queue, 'install.lock'), JSON.stringify({ pid: 4242, job: 'RQ-X', command: 'npm ci', since: 1 }));
    expect((await readAdmission(probes({ pidAlive: () => true }))).installLock.holder).toMatchObject({ pid: 4242, job: 'RQ-X' });
    expect((await readAdmission(probes({ pidAlive: () => false }))).installLock.holder).toBeNull();
    await writeFile(join(queue, 'install.lock'), 'not json');
    expect((await readAdmission(probes({ pidAlive: () => true }))).installLock.holder).toBeNull();
    await writeFile(join(queue, 'install.lock'), '');
    expect((await readAdmission(probes({ pidAlive: () => true }))).installLock.holder).toBeNull();
  });
  it('queue/LOADGATE_OFF disables the gate', async () => {
    await writeFile(join(queue, 'LOADGATE_OFF'), '');
    expect(await readAdmission(probes({ load1: () => 500 }))).toMatchObject({ admit: true, disabled: true });
  });
  it('missing slots and status read as cap 0 and nothing running, blocking claims', async () => {
    await rm(join(queue, 'slots.json')); await rm(join(queue, 'status.json'));
    expect(await readAdmission(probes())).toMatchObject({ cap: 0, running: 0, admit: false });
  });

  it('--json prints the report; text prints the verdict; bad arguments exit 2', async () => {
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m: string) => { err.push(String(m)); });
    await writeFile(join(queue, 'install.lock'), JSON.stringify({ pid: 7, job: 'RQ-HOLD', command: 'bun install' }));
    const deps = probes({ pidAlive: () => true });
    expect(await cmdPool(['admission', '--json'], deps)).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({ admit: true, reason: null, ncpu: 18, cap: 6, running: 4, load: { load1: 2 }, installLock: { holder: { pid: 7, job: 'RQ-HOLD' } } });
    expect(await cmdPool(['admission'], probes({ pidAlive: () => true, load1: () => 99 }))).toBe(0);
    expect(out[1]).toContain('admit=false reason=loadavg 99.0 > 36.0');
    expect(out[1]).toContain('install lock holder=pid 7 job RQ-HOLD (bun install)');
    expect(await cmdPool(['admission', '--bogus'], deps)).toBe(2);
    expect(await cmdPool(['admission', '--json', '--json'], deps)).toBe(2);
    expect(await cmdPool([], deps)).toBe(2);
    expect(await cmdPool(['--help'])).toBe(0);
    expect(err.length).toBe(3);
  });
  it('--json stays valid JSON when the process table is unreadable', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); });
    await cmdPool(['admission', '--json'], probes({ countProcesses: async () => { throw new Error('x'); } }));
    expect(JSON.parse(out[0]!)).toMatchObject({ admit: false, procs: null });
  });
});

describe('slots.json readers tolerate the global hard_cap', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pool-admission-slots-'));
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ devin: lane(4, { held: true, hard_cap: 8 }), hard_cap: 18 }));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  it('lists only lanes, keeps hard_cap on rewrite, and bounds a target by the lane hard_cap', async () => {
    const snapshot = await readLaneTargets({ runsDir: dir });
    expect(snapshot.lanes.map(l => l.lane)).toEqual(['devin']);
    await expect(setLaneTarget('devin', 9, { runsDir: dir })).rejects.toThrow();
    await setLaneTarget('devin', 8, { runsDir: dir });
    await releaseLaneHold('devin', { runsDir: dir });
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'queue/slots.json'), 'utf8'));
    expect(raw.hard_cap).toBe(18);
    expect(raw.devin).toMatchObject({ target: 8, hard_cap: 8 });
  });
});
