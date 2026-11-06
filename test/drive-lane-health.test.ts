import { describe, expect, it } from 'vitest';
import { claudeApiHealth, RECOVERY_PROBE_MS } from '../src/core/drive/lane-health.js';
import { driveTick, parseDriveSnapshot, planDrive, type DriveBridge, type DriveJob, type DriveSnapshot } from '../src/core/drive/supervisor.js';

const now = 10_000_000;
const finish = (id: string, at: number, exitCode = 13, emptyFinish = false): DriveJob =>
  ({ id, pool: 'claude-api', state: 'FAILED', priority: 1, completedAtMs: at, exitCode, emptyFinish });
const ready = (id: string, pool = 'claude-api'): DriveJob => ({ id, pool, state: 'READY', priority: 1 });
const snapshot = (jobs: DriveJob[]): DriveSnapshot => ({ version: 1, pools: [
  { id: 'claude-api', floor: 2, ceiling: 3 }, { id: 'devin', floor: 1, ceiling: 3 },
], maxRunning: 5, paused: false, admission: 'open', jobs });
const failures = () => [finish('f1', now - 2000), finish('f2', now - 1000)];

describe('drive claude-api health circuit', () => {
  it('parks repeated code 13 while dispatching healthy eligible jobs', () => {
    const state = snapshot([...failures(), ready('api'), ready('RQ-GEN-healthy', 'devin')]);
    expect(claudeApiHealth(state.jobs, now).reason).toBe('repeated-code-13');
    expect(planDrive(state, now)).toEqual(['RQ-GEN-healthy']);
  });
  it('uses a strict majority and a rolling hour, excluding future finishes', () => {
    const jobs = [finish('ok', now - 3000, 0), finish('empty', now - 2000, 0, true)];
    expect(claudeApiHealth(jobs, now).reason).toBeNull();
    expect(claudeApiHealth([...jobs, finish('empty2', now - 1000, 0, true)], now).reason)
      .toBe('empty-finishes-over-50-percent');
    expect(claudeApiHealth([finish('old', now - 3_600_000), finish('new', now)], now).reason).toBeNull();
    expect(claudeApiHealth([finish('new', now), finish('future', now + 1)], now).reason).toBeNull();
  });
  it('keeps a quiet lane parked and admits only one recovery job after five minutes', () => {
    const state = snapshot([...failures(), ready('api1'), ready('api2')]);
    const due = now - 1000 + RECOVERY_PROBE_MS;
    expect(planDrive(state, due - 1)).toEqual([]);
    expect(planDrive(state, due)).toEqual(['api1']);
    state.jobs.push({ ...ready('probe'), state: 'STARTING' });
    expect(planDrive(state, due + 3_600_000)).toEqual([]);
    expect(claudeApiHealth(state.jobs, due + 3_600_000).reason).toBe('repeated-code-13');
  });
  it('backs off failed probes and restores normal capacity only after productive success', () => {
    const at = now + RECOVERY_PROBE_MS;
    const jobs = [...failures(), finish('probe1', at, 0, true), ready('api1'), ready('api2')];
    expect(planDrive(snapshot(jobs), at)).toEqual([]);
    jobs.push(finish('probe2', at + RECOVERY_PROBE_MS, 0, false));
    expect(planDrive(snapshot(jobs), at + RECOVERY_PROBE_MS)).toEqual(['api1', 'api2']);
    expect(claudeApiHealth(jobs, at + RECOVERY_PROBE_MS).reason).toBeNull();
  });
  it('preserves admission and ceiling gates on probes', () => {
    const state = snapshot([...failures(), ready('api')]);
    state.admission = 'closed';
    expect(planDrive(state, now + RECOVERY_PROBE_MS)).toEqual([]);
    state.admission = 'open'; state.pools[0]!.ceiling = 0; state.pools[0]!.floor = 0;
    expect(planDrive(state, now + RECOVERY_PROBE_MS)).toEqual([]);
  });
  it('rejects missing or malformed API completion evidence', () => {
    for (const patch of [{ completedAtMs: undefined }, { emptyFinish: undefined }, { completedAtMs: -1 }, { emptyFinish: 'yes' }]) {
      expect(() => parseDriveSnapshot(snapshot([{ ...finish('f', now), ...patch } as DriveJob]))).toThrow('Invalid');
    }
  });
  it('logs the hold reason in the tick report and launches healthy work', async () => {
    const state = snapshot([...failures(), ready('api'), ready('api2'), ready('healthy', 'devin')]);
    let logged: unknown;
    const bridge: DriveBridge = {
      snapshot: async () => structuredClone(state), acquire: async () => 'lease', reap: async () => {},
      reservePublish: async () => false, finishPublish: async () => {}, release: async () => {},
      writeStatus: async (_lease, report) => { logged = report; },
      launch: async (_lease, id) => { state.jobs.find(j => j.id === id)!.state = 'RUNNING'; return 'launched'; },
    };
    const report = await driveTick({ bridge, paused: async () => false, publish: async () => {}, now: () => new Date(now) });
    expect(report.launched).toEqual(['healthy']);
    expect(logged).toMatchObject({ laneHealth: { reason: 'repeated-code-13', probeAtMs: now - 1000 + RECOVERY_PROBE_MS } });
    const deps = { bridge, paused: async () => false, publish: async () => {}, now: () => new Date(now + RECOVERY_PROBE_MS) };
    expect((await driveTick(deps)).launched).toEqual(['api']);
    expect((await driveTick(deps)).launched).toEqual([]);
  });
});
