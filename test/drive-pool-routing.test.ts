import { describe, expect, it } from 'vitest';
import {
  CLOUD_ROUTE_KINDS, CLOUD_ROUTE_POOLS, PERSONAL_ONLY_KINDS,
  driveJobKind, drivePoolAllowed, isPoolDayShare, pacedShareAllowance, pacedShareRemaining,
} from '../src/core/drive/pool-routing.js';
import { driveTick, parseDriveSnapshot, planDrive, type DriveBridge, type DriveJob, type DriveSnapshot } from '../src/core/drive/supervisor.js';
import { projectDriveQueueV1, type DriveQueueV1 } from '../src/core/drive/queue-v1.js';

const PERSONAL = 'codex-personal';
const OTHER_POOLS = ['codex-cmp', 'devin', 'codex-local', 'claude-api'];

describe('driveJobKind', () => {
  it.each([
    ['RQ-GEN-phantom-1', 'GEN'], ['LAND-phantom-1', 'LAND'], ['RQ-LAND-9', 'LAND'],
    ['RQ-FIXUP-2', 'FIXUP'], ['FIXUP-x', 'FIXUP'], ['DRAIN-3', 'DRAIN'],
    ['RQ-DAILYFIX-1', 'DAILYFIX'], ['SELFOPT_9', 'SELFOPT'], ['RQ-SELFOPT-phantom', 'SELFOPT'],
    ['RQ-DESK-7', 'DESK'], ['DESK-x', 'DESK'], ['RQ-PLAN-4', 'PLAN'],
    ['RQ-MR-7-POOL-ROUTING', 'MR'], ['RQ-REFILL-phantom-1-LAND-phantom-1', 'REFILL'],
    ['GEN', 'GEN'], ['RQ-GEN', 'GEN'],
  ])('extracts the leading kind of %s', (jobId, kind) => {
    expect(driveJobKind(jobId)).toBe(kind);
  });
  it.each(['next', 'rq-gen-1', 'lowercase', '9GEN-1', '-GEN', ''])('has no kind for %s', (jobId) => {
    expect(driveJobKind(jobId)).toBeNull();
  });
});

describe('drivePoolAllowed', () => {
  it('sends only LAND, FIXUP, DRAIN and DAILYFIX lines to codex-personal', () => {
    for (const kind of PERSONAL_ONLY_KINDS) {
      expect(drivePoolAllowed(`RQ-${kind}-1`, PERSONAL)).toBe(true);
      expect(drivePoolAllowed(`${kind}-1`, PERSONAL)).toBe(true);
    }
  });
  it('does not pin personal-only kinds away from other pools', () => {
    // The rule bounds what enters codex-personal; landing work may still be
    // declared for another lane by the queue owner.
    for (const kind of PERSONAL_ONLY_KINDS) {
      for (const pool of OTHER_POOLS) expect(drivePoolAllowed(`${kind}-1`, pool)).toBe(true);
    }
  });
  it('routes GEN, PLAN, SELFOPT and DESK only to devin or codex-local', () => {
    for (const kind of CLOUD_ROUTE_KINDS) {
      for (const pool of CLOUD_ROUTE_POOLS) expect(drivePoolAllowed(`RQ-${kind}-1`, pool)).toBe(true);
      for (const pool of [PERSONAL, 'codex-cmp', 'claude', 'claude-api']) {
        expect(drivePoolAllowed(`RQ-${kind}-1`, pool)).toBe(false);
      }
    }
  });
  it('keeps every other kind out of codex-personal but free elsewhere', () => {
    for (const jobId of ['RQ-MR-7-POOL-ROUTING', 'RQ-SECFIX-1', 'RQ-REFILL-1-LAND-1', 'next']) {
      expect(drivePoolAllowed(jobId, PERSONAL)).toBe(false);
      for (const pool of OTHER_POOLS) expect(drivePoolAllowed(jobId, pool)).toBe(true);
    }
  });
});

describe('PoolDayShare', () => {
  const day = { share: 10, used: 0, startMs: 1_000, endMs: 2_000 };
  it('vests the share evenly across the window', () => {
    expect(pacedShareAllowance(day, 1_000)).toBe(0);
    expect(pacedShareAllowance(day, 1_099)).toBe(0);
    expect(pacedShareAllowance(day, 1_100)).toBe(1);
    expect(pacedShareAllowance(day, 1_500)).toBe(5);
    expect(pacedShareAllowance(day, 1_999)).toBe(9);
  });
  it('admits nothing before or after its own window', () => {
    expect(pacedShareAllowance(day, 999)).toBe(0);
    expect(pacedShareAllowance(day, 2_000)).toBe(0);
    expect(pacedShareAllowance(day, 100_000)).toBe(0);
    expect(pacedShareAllowance(day, Number.NaN)).toBe(0);
  });
  it('subtracts what the bridge already counted and never goes negative', () => {
    expect(pacedShareRemaining({ ...day, used: 3 }, 1_500)).toBe(2);
    expect(pacedShareRemaining({ ...day, used: 9 }, 1_900)).toBe(0);
    expect(pacedShareRemaining({ ...day, used: 10 }, 1_999)).toBe(0);
  });
  it.each([
    ['missing share', { used: 0, startMs: 1, endMs: 2 }],
    ['negative share', { share: -1, used: 0, startMs: 1, endMs: 2 }],
    ['fractional share', { share: 1.5, used: 0, startMs: 1, endMs: 2 }],
    ['negative used', { share: 1, used: -1, startMs: 1, endMs: 2 }],
    ['inverted window', { share: 1, used: 0, startMs: 2, endMs: 2 }],
    ['fractional times', { share: 1, used: 0, startMs: 1.5, endMs: 2 }],
    ['an array', [1, 2, 3]],
    ['a string', 'daily'],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isPoolDayShare(value)).toBe(false);
  });
  it('accepts a whole window', () => {
    expect(isPoolDayShare(day)).toBe(true);
    expect(isPoolDayShare({ share: 0, used: 0, startMs: 0, endMs: 1 })).toBe(true);
  });
});

const snap = (jobs: DriveJob[], pools: DriveSnapshot['pools'], extra: Partial<DriveSnapshot> = {}): DriveSnapshot =>
  ({ version: 1, pools, maxRunning: 10, paused: false, admission: 'open', jobs, ...extra });
const ready = (id: string, pool: string, priority = 0): DriveJob => ({ id, pool, state: 'READY', priority });
const open = (id: string, ceiling = 4): DriveSnapshot['pools'][number] => ({ id, floor: 0, ceiling });

describe('planDrive pool routing', () => {
  const pools = [open(PERSONAL), open('devin'), open('codex-local'), open('codex-cmp')];
  it('launches landing work on codex-personal', () => {
    expect(planDrive(snap([ready('RQ-LAND-1', PERSONAL), ready('RQ-FIXUP-2', PERSONAL), ready('DRAIN-3', PERSONAL), ready('RQ-DAILYFIX-4', PERSONAL)], pools)))
      .toEqual(['RQ-LAND-1', 'RQ-FIXUP-2', 'DRAIN-3', 'RQ-DAILYFIX-4']);
  });
  it('never plans a cloud-route kind on codex-personal or another subscription lane', () => {
    const jobs = CLOUD_ROUTE_KINDS.map(kind => ready(`RQ-${kind}-1`, PERSONAL));
    jobs.push(ready('RQ-GEN-2', 'codex-cmp'));
    expect(planDrive(snap(jobs, pools))).toEqual([]);
  });
  it('plans cloud-route kinds on devin and codex-local', () => {
    const jobs = CLOUD_ROUTE_KINDS.map(kind => ready(`RQ-${kind}-1`, 'devin'));
    jobs.push(ready('RQ-DESK-9', 'codex-local'));
    expect(planDrive(snap(jobs, pools)).sort()).toEqual(jobs.map(job => job.id).sort());
  });
  it('leaves a violating line queued without re-pooling it', () => {
    const jobs = [ready('RQ-GEN-1', PERSONAL), ready('RQ-LAND-1', PERSONAL)];
    expect(planDrive(snap(jobs, pools))).toEqual(['RQ-LAND-1']);
    expect(planDrive(snap(jobs, pools))).not.toContain('RQ-GEN-1');
  });
  it('keeps unrouted kinds eligible on their declared pool', () => {
    expect(planDrive(snap([ready('RQ-MR-1', 'codex-cmp'), ready('next', 'devin')], pools)))
      .toEqual(['RQ-MR-1', 'next']);
  });
});

describe('planDrive paced daily share', () => {
  const T0 = 1_000_000;
  const window = { startMs: T0, endMs: T0 + 100_000 };
  const paced = (share: number, used = 0): DriveSnapshot['pools'][number] =>
    ({ id: PERSONAL, floor: 0, ceiling: 10, daily: { share, used, ...window } });
  it('caps the pool at the vested share, not the raw daily total', () => {
    const jobs = [ready('LAND-1', PERSONAL), ready('LAND-2', PERSONAL), ready('LAND-3', PERSONAL)];
    expect(planDrive(snap(jobs, [paced(4)]), T0 + 50_000)).toEqual(['LAND-1', 'LAND-2']);
    expect(planDrive(snap(jobs, [paced(4)]), T0 + 25_000)).toEqual(['LAND-1']);
  });
  it('debits share already spent this window', () => {
    const jobs = [ready('LAND-1', PERSONAL), ready('LAND-2', PERSONAL)];
    expect(planDrive(snap(jobs, [paced(4, 2)]), T0 + 50_000)).toEqual([]);
    expect(planDrive(snap(jobs, [paced(4, 1)]), T0 + 50_000)).toEqual(['LAND-1']);
  });
  it('admits nothing when the window is stale or unstarted', () => {
    const jobs = [ready('LAND-1', PERSONAL)];
    expect(planDrive(snap(jobs, [paced(10)]), T0 + 100_000)).toEqual([]);
    expect(planDrive(snap(jobs, [paced(10)]), T0 - 1)).toEqual([]);
  });
  it('still honors ceilings and floors under the share cap', () => {
    const jobs = [ready('LAND-1', PERSONAL), ready('LAND-2', PERSONAL), ready('LAND-3', PERSONAL)];
    expect(planDrive(snap(jobs, [{ ...paced(10), ceiling: 1 }]), T0 + 99_000)).toEqual(['LAND-1']);
  });
  it('leaves unpaced pools bounded by ceiling alone', () => {
    const jobs = [ready('LAND-1', PERSONAL), ready('LAND-2', PERSONAL), ready('LAND-3', PERSONAL)];
    expect(planDrive(snap(jobs, [open(PERSONAL, 2)]), T0 + 50_000)).toEqual(['LAND-1', 'LAND-2']);
  });
  it('accepts the share in parseDriveSnapshot and rejects malformed shares', () => {
    const good = snap([], [{ id: PERSONAL, floor: 0, ceiling: 1, daily: { share: 1, used: 0, ...window } }]);
    expect(parseDriveSnapshot(good).pools[0]!.daily).toEqual({ share: 1, used: 0, ...window });
    for (const daily of [{ share: -1, used: 0, ...window }, { share: 1, used: 0, startMs: window.endMs, endMs: window.startMs }, 'yes', 4]) {
      expect(() => parseDriveSnapshot(snap([], [{ id: PERSONAL, floor: 0, ceiling: 1, daily: daily as never }])))
        .toThrow('Invalid drive bridge snapshot');
    }
  });
});

describe('projectDriveQueueV1 pool routing', () => {
  const qjob = (id: string, pool = PERSONAL, status: DriveQueueV1['jobs'][number]['status'] = 'READY'): DriveQueueV1['jobs'][number] =>
    ({ id, status, priority: 'P0', pool, tier: 'frontier', repo: 'phantom', deps: [] });
  it('holds READY lines whose pool violates the kind policy', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [qjob('RQ-GEN-1'), qjob('RQ-LAND-1'), qjob('RQ-DESK-1', 'devin')] };
    expect(projectDriveQueueV1(queue).map(item => [item.id, item.state]))
      .toEqual([['RQ-GEN-1', 'HELD'], ['RQ-LAND-1', 'READY'], ['RQ-DESK-1', 'READY']]);
  });
  it('does not rewrite the state of a claimed line even when its pool violates policy', () => {
    const queue: DriveQueueV1 = { schema: 'queue.v1', jobs: [qjob('RQ-GEN-1', PERSONAL, 'CLAIMED')] };
    expect(projectDriveQueueV1(queue)[0]!.state).toBe('STARTING');
  });
});

describe('driveTick pool routing', () => {
  const bridgeFor = (state: DriveSnapshot): DriveBridge & { launched: string[] } => {
    const launched: string[] = [];
    return {
      launched,
      async snapshot() { return state; },
      async acquire() { return 'lease'; },
      async reap() { },
      async launch(_lease, job) {
        launched.push(job);
        // The real bridge persists STARTING; the supervisor verifies that.
        const record = state.jobs.find(item => item.id === job);
        if (record) record.state = 'STARTING';
        return 'launched';
      },
      async reservePublish() { return false; },
      async finishPublish() { },
      async writeStatus() { },
      async release() { },
    };
  };
  const deps = (state: DriveSnapshot) => ({ bridge: bridgeFor(state), paused: async () => false, publish: async () => { } });
  it('dry-run plans exclude policy-violating lines', async () => {
    const state = snap([ready('RQ-GEN-1', PERSONAL), ready('RQ-LAND-1', PERSONAL)], [open(PERSONAL)]);
    const report = await driveTick(deps(state), { dryRun: true });
    expect(report.planned).toEqual(['RQ-LAND-1']);
  });
  it('launch honors the paced share reported with the snapshot clock', async () => {
    const T0 = 1_000_000;
    const state = snap([ready('LAND-1', PERSONAL), ready('LAND-2', PERSONAL)],
      [{ id: PERSONAL, floor: 0, ceiling: 4, daily: { share: 2, used: 0, startMs: T0, endMs: T0 + 100_000 } }]);
    const bridge = bridgeFor(state);
    const report = await driveTick(
      { bridge, paused: async () => false, publish: async () => { }, now: () => new Date(T0 + 50_000) });
    // Half the window vested one dispatch of the two-share day.
    expect(report.launched).toEqual(['LAND-1']);
    expect(bridge.launched).toEqual(['LAND-1']);
    // The planned line that exceeded the share stays queued for a later tick.
    expect(state.jobs.find(job => job.id === 'LAND-2')!.state).toBe('READY');
  });
});
