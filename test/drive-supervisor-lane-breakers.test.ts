import { describe, expect, it } from 'vitest';
import { LANE_BREAKER_STREAK } from '../src/core/drive/lane-breaker.js';
import { RECOVERY_PROBE_MS } from '../src/core/drive/lane-health.js';
import {
  driveTick, planDrive,
  type DriveBridge, type DriveJob, type DriveReport, type DriveSnapshot,
} from '../src/core/drive/supervisor.js';

const now = 10_000_000;
const lastFinish = now - 1000;
const probeAt = lastFinish + RECOVERY_PROBE_MS;

const finish = (id: string, pool: string, at: number, exitCode: number, emptyFinish: boolean): DriveJob =>
  ({ id, pool, state: 'FAILED', priority: 1, completedAtMs: at, exitCode, emptyFinish });
const bad = (id: string, pool: string, at: number): DriveJob => finish(id, pool, at, 1, true);
const good = (id: string, pool: string, at: number): DriveJob => finish(id, pool, at, 0, false);
const ready = (id: string, pool: string): DriveJob => ({ id, pool, state: 'READY', priority: 1 });
const deadStreak = (pool: string, end: number): DriveJob[] =>
  Array.from({ length: LANE_BREAKER_STREAK }, (_, i) =>
    bad(`${pool}-dead-${i}`, pool, end - (LANE_BREAKER_STREAK - 1 - i) * 1000));
const snapshot = (jobs: DriveJob[]): DriveSnapshot => ({
  version: 1,
  pools: [{ id: 'pool-a', floor: 1, ceiling: 3 }, { id: 'pool-b', floor: 1, ceiling: 3 }],
  maxRunning: 6, paused: false, admission: 'open', jobs,
});
const bridge = (state: DriveSnapshot, logged?: { report?: DriveReport }): DriveBridge => ({
  snapshot: async () => structuredClone(state),
  acquire: async () => 'lease', reap: async () => {},
  reservePublish: async () => false, finishPublish: async () => {}, release: async () => {},
  writeStatus: async (_lease, report) => { if (logged) logged.report = report; },
  launch: async (_lease, id) => { state.jobs.find(job => job.id === id)!.state = 'RUNNING'; return 'launched'; },
});
const deps = (state: DriveSnapshot, at: number, logged?: { report?: DriveReport }) =>
  ({ bridge: bridge(state, logged), paused: async () => false, publish: async () => {}, now: () => new Date(at) });

describe('drive supervisor per-pool lane breakers', () => {
  it('holds a dead pool at zero while other pools keep launching', () => {
    const state = snapshot([...deadStreak('pool-a', lastFinish),
      ready('a1', 'pool-a'), ready('a2', 'pool-a'), ready('b1', 'pool-b')]);
    expect(planDrive(state, now)).toEqual(['b1']);
    expect(planDrive(state, probeAt - 1)).toEqual(['b1']);
  });

  it('admits exactly one ordinary probe once the probe time passes', () => {
    const state = snapshot([...deadStreak('pool-a', lastFinish),
      ready('a1', 'pool-a'), ready('a2', 'pool-a'), ready('b1', 'pool-b')]);
    const planned = planDrive(state, probeAt);
    expect(planned).toEqual(['a1', 'b1']);
    expect(planned.filter(id => id.startsWith('a'))).toHaveLength(1);
  });

  it('blocks a second probe while the first is still starting or running', () => {
    for (const probeState of ['STARTING', 'RUNNING'] as const) {
      const state = snapshot([...deadStreak('pool-a', lastFinish),
        { ...ready('probe', 'pool-a'), state: probeState }, ready('a1', 'pool-a'), ready('b1', 'pool-b')]);
      expect(planDrive(state, probeAt)).toEqual(['b1']);
    }
  });

  it('closes the pool on a non-empty exit-zero finish', () => {
    const state = snapshot([...deadStreak('pool-a', now - 2000), good('a-good', 'pool-a', lastFinish),
      ready('a1', 'pool-a'), ready('a2', 'pool-a'), ready('b1', 'pool-b')]);
    expect(planDrive(state, now)).toEqual(['a1', 'b1', 'a2']);
  });

  it('reopens with a fresh probe window when the probe finishes empty-nonzero too', () => {
    const jobs = [...deadStreak('pool-a', lastFinish), bad('probe-failed', 'pool-a', probeAt),
      ready('a1', 'pool-a'), ready('b1', 'pool-b')];
    expect(planDrive(snapshot(jobs), probeAt + 1)).toEqual(['b1']);
    expect(planDrive(snapshot(jobs), probeAt + RECOVERY_PROBE_MS)).toEqual(['a1', 'b1']);
  });

  it('leaves a pool without completion evidence unlimited and never plans synthetic work', () => {
    const state = snapshot([ready('a1', 'pool-a'), ready('a2', 'pool-a'), ready('a3', 'pool-a'), ready('a4', 'pool-a')]);
    expect(planDrive(state, now)).toEqual(['a1', 'a2', 'a3']);
  });

  it('reports every pool breaker in the tick report and launches around the dead pool', async () => {
    const logged: { report?: DriveReport } = {};
    const state = snapshot([...deadStreak('pool-a', lastFinish), ready('a1', 'pool-a'), ready('b1', 'pool-b')]);
    const report = await driveTick(deps(state, now, logged));
    expect(report.launched).toEqual(['b1']);
    const breakers = [
      { pool: 'pool-a', state: 'open', reason: 'empty-nonzero-streak', probeAtMs: probeAt },
      { pool: 'pool-b', state: 'closed', reason: null, probeAtMs: null },
    ];
    expect(report.laneBreakers).toEqual(breakers);
    expect(logged.report?.laneBreakers).toEqual(breakers);
  });

  it('launches exactly one dead-pool job through a full tick once the probe is due', async () => {
    const state = snapshot([...deadStreak('pool-a', lastFinish),
      ready('a1', 'pool-a'), ready('a2', 'pool-a'), ready('b1', 'pool-b')]);
    const report = await driveTick(deps(state, probeAt));
    expect(report.launched).toEqual(['a1', 'b1']);
    expect(state.jobs.filter(job => job.pool === 'pool-a' && job.state === 'RUNNING')).toHaveLength(1);
    expect(state.jobs.find(job => job.id === 'a2')!.state).toBe('READY');
  });
});
