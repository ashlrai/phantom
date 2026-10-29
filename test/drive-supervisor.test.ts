import { describe, expect, it, vi } from 'vitest';
import {
  driveLoop, driveTick, parseDriveSnapshot, planDrive,
  type DriveBridge, type DriveDependencies, type DriveJob, type DriveSnapshot,
} from '../src/core/drive/supervisor.js';

function job(id: string, state: DriveJob['state'] = 'READY', pool = 'codex', priority = 0): DriveJob {
  return { id, state, pool, priority, ...(state === 'FINISHED' ? { exitCode: 0 } : {}) };
}

function fixture(jobs: DriveJob[] = [job('next')]) {
  const state: DriveSnapshot = {
    version: 1, pools: [{ id: 'codex', floor: 0, ceiling: 2 }], maxRunning: 2,
    paused: false, admission: 'open', jobs,
  };
  const calls: string[] = [];
  const completions = new Map<string, number>();
  const bridge: DriveBridge = {
    snapshot: vi.fn(async () => structuredClone(state)),
    acquire: vi.fn(async () => { calls.push('acquire'); return 'lease'; }),
    reap: vi.fn(async () => {
      calls.push('reap');
      for (const item of state.jobs) {
        const exitCode = completions.get(item.id);
        if (item.state === 'RUNNING' && exitCode !== undefined) {
          item.state = exitCode === 0 ? 'FINISHED' : 'FAILED';
          item.exitCode = exitCode;
        }
      }
    }),
    launch: vi.fn(async (_lease, id) => {
      calls.push(`launch:${id}`);
      state.jobs.find(item => item.id === id)!.state = 'RUNNING';
      return 'launched';
    }),
    reservePublish: vi.fn(async (_lease, id) => {
      calls.push(`reserve:${id}`);
      const item = state.jobs.find(candidate => candidate.id === id)!;
      if (item.state !== 'FINISHED') return false;
      item.state = 'PUBLISHING';
      return true;
    }),
    finishPublish: vi.fn(async (_lease, id, outcome) => {
      calls.push(`finish:${id}:${outcome}`);
      state.jobs.find(item => item.id === id)!.state = outcome === 'published' ? 'PUBLISHED' : 'PUBLISH_UNKNOWN';
    }),
    writeStatus: vi.fn(async () => { calls.push('status'); }),
    release: vi.fn(async () => { calls.push('release'); }),
  };
  const deps: DriveDependencies = {
    bridge, paused: vi.fn(async () => false),
    publish: vi.fn(async id => {
      expect(state.jobs.find(item => item.id === id)?.state).toBe('PUBLISHING');
      calls.push(`publish:${id}`);
    }),
    now: () => new Date('2026-10-26T12:00:00Z'),
  };
  return { state, bridge, deps, calls, completions };
}

describe('drive supervisor scheduling', () => {
  it('reaps completed work, publishes through the reserved callback, and fills its freed slot', async () => {
    const f = fixture([job('done', 'RUNNING'), job('next')]);
    f.state.maxRunning = f.state.pools[0]!.ceiling = 1;
    f.completions.set('done', 0);
    const report = await driveTick(f.deps);
    expect(report).toMatchObject({ published: ['done'], launched: ['next'], active: 1, ready: 0 });
    expect(f.calls).toEqual(['acquire', 'reap', 'reserve:done', 'publish:done', 'finish:done:published', 'launch:next', 'status', 'release']);
    await driveTick(f.deps);
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
  });

  it('does not publish unsuccessful jobs', async () => {
    const f = fixture([job('bad', 'RUNNING'), { ...job('finished', 'FINISHED'), exitCode: 3 }]);
    f.completions.set('bad', 1);
    await driveTick(f.deps);
    expect(f.state.jobs[0]!.state).toBe('FAILED');
    expect(f.deps.publish).not.toHaveBeenCalled();
  });

  it('honors PAUSE while continuing to reap and settle successful work', async () => {
    const f = fixture([job('done', 'RUNNING'), job('next')]);
    f.completions.set('done', 0);
    vi.mocked(f.deps.paused).mockResolvedValue(true);
    const report = await driveTick(f.deps);
    expect(report).toMatchObject({ paused: true, held: 'paused', published: ['done'], launched: [] });
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it('rechecks PAUSE immediately before launching', async () => {
    const f = fixture();
    let checks = 0;
    vi.mocked(f.deps.paused).mockImplementation(async () => ++checks >= 4);
    const report = await driveTick(f.deps);
    expect(report.planned).toEqual(['next']);
    expect(report.held).toBe('paused');
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it('honors the native queue pause even when the local control probe is clear', async () => {
    const f = fixture();
    f.state.paused = true;
    expect((await driveTick(f.deps)).held).toBe('paused');
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it.each(['closed', 'unknown'] as const)('holds new work when admission is %s', async admission => {
    const f = fixture();
    f.state.admission = admission;
    expect((await driveTick(f.deps)).held).toBe(`admission-${admission}`);
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it('counts imported STARTING and RUNNING jobs against global capacity', () => {
    const f = fixture([job('external-start', 'STARTING'), job('external-run', 'RUNNING'), job('next')]);
    expect(planDrive(f.state)).toEqual([]);
  });

  it('counts STARTING jobs against pool ceilings while other pools can launch', () => {
    const f = fixture([job('external', 'STARTING'), job('codex-next'), job('claude-next', 'READY', 'claude')]);
    f.state.pools[0]!.ceiling = 1;
    f.state.pools.push({ id: 'claude', floor: 0, ceiling: 1 });
    expect(planDrive(f.state)).toEqual(['claude-next']);
  });

  it('fills pool floors before higher priority surplus and preserves queue order on ties', () => {
    const f = fixture([job('existing', 'RUNNING'), job('surplus', 'READY', 'codex', 99), job('floor-first', 'READY', 'claude'), job('floor-second', 'READY', 'claude')]);
    f.state.pools[0]!.floor = 1;
    f.state.pools.push({ id: 'claude', floor: 1, ceiling: 2 });
    f.state.maxRunning = 4;
    expect(planDrive(f.state)).toEqual(['floor-first', 'surplus', 'floor-second']);
  });

  it('does not stop existing jobs when a ceiling is lowered below current occupancy', async () => {
    const f = fixture([job('running', 'RUNNING'), job('next')]);
    f.state.pools[0]!.ceiling = 0;
    await driveTick(f.deps);
    expect(f.state.jobs[0]!.state).toBe('RUNNING');
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it('refreshes occupancy after each launch instead of trusting its initial plan', async () => {
    const f = fixture([job('first'), job('second')]);
    vi.mocked(f.bridge.launch).mockImplementation(async (_lease, id) => {
      f.state.jobs.find(item => item.id === id)!.state = 'RUNNING';
      f.state.jobs.push(job('external', 'STARTING'));
      return 'launched';
    });
    expect((await driveTick(f.deps)).launched).toEqual(['first']);
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
  });

  it('lets the atomic bridge refuse a launch after planning', async () => {
    const f = fixture();
    vi.mocked(f.bridge.launch).mockResolvedValue('held');
    const report = await driveTick(f.deps);
    expect(report).toMatchObject({ planned: ['next'], launched: [], held: 'launch-held' });
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
    expect(f.state.jobs[0]!.state).toBe('READY');
  });

  it('bounds a tick to its initial launch budget when instant completions admit new arrivals', async () => {
    const f = fixture([job('first')]);
    f.state.maxRunning = 1;
    let launches = 0;
    vi.mocked(f.bridge.launch).mockImplementation(async (_lease, id) => {
      // A broken unbounded scheduler must fail this test without hanging it.
      if (++launches > 3) throw new Error('tick kept draining new arrivals');
      const completed = f.state.jobs.find(item => item.id === id)!;
      completed.state = 'FINISHED';
      completed.exitCode = 0;
      f.state.jobs.push(job(`arrival-${launches}`));
      return 'launched';
    });
    const report = await driveTick(f.deps);
    expect(report).toMatchObject({ planned: ['first'], launched: ['first'], ready: 1 });
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
    expect(f.bridge.writeStatus).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });
});

describe('drive supervisor recovery and isolation', () => {
  it('dry-run reads without owning, reaping, launching, publishing or writing anything', async () => {
    const f = fixture([job('done', 'FINISHED'), job('next')]);
    expect(await driveTick(f.deps, { dryRun: true })).toMatchObject({ dryRun: true, planned: ['next'], launched: [], published: [] });
    expect(f.calls).toEqual([]);
    expect(f.bridge.snapshot).toHaveBeenCalledWith(undefined);
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.state.jobs.map(item => item.state)).toEqual(['FINISHED', 'READY']);
  });

  it('does not touch native state while the fallback owns the shared lease', async () => {
    const f = fixture();
    vi.mocked(f.bridge.acquire).mockResolvedValue(null);
    expect((await driveTick(f.deps)).held).toBe('ownership-busy');
    expect(f.bridge.snapshot).not.toHaveBeenCalled();
    expect(f.bridge.reap).not.toHaveBeenCalled();
    expect(f.bridge.writeStatus).not.toHaveBeenCalled();
    expect(f.bridge.release).not.toHaveBeenCalled();
  });

  it('leaves ambiguous publication quarantined instead of retrying it next tick', async () => {
    const f = fixture([job('done', 'FINISHED')]);
    vi.mocked(f.deps.publish).mockRejectedValue(new Error('acknowledgement lost'));
    expect((await driveTick(f.deps)).publicationUnknown).toEqual(['done']);
    expect(f.state.jobs[0]!.state).toBe('PUBLISH_UNKNOWN');
    await driveTick(f.deps);
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
  });

  it('does not publish without a reservation', async () => {
    const f = fixture([job('done', 'FINISHED')]);
    vi.mocked(f.bridge.reservePublish).mockResolvedValue(false);
    await driveTick(f.deps);
    expect(f.deps.publish).not.toHaveBeenCalled();
  });

  it('does not replay publication when persisting its acknowledgement failed', async () => {
    const f = fixture([job('done', 'FINISHED')]);
    vi.mocked(f.bridge.finishPublish).mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(driveTick(f.deps)).rejects.toThrow('disk unavailable');
    expect(f.state.jobs[0]!.state).toBe('PUBLISHING');
    await driveTick(f.deps);
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledTimes(2);
  });

  it('keeps lost launch replies capacity-consuming across restart', async () => {
    const f = fixture([job('next'), job('later')]);
    f.state.maxRunning = 1;
    vi.mocked(f.bridge.launch).mockImplementationOnce(async (_lease, id) => {
      f.state.jobs.find(item => item.id === id)!.state = 'STARTING';
      throw new Error('launch reply lost');
    });
    await expect(driveTick(f.deps)).rejects.toThrow('launch reply lost');
    expect((await driveTick(f.deps)).launched).toEqual([]);
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledTimes(2);
  });

  it('fails the tick when a bridge claims launch without persisting its transition', async () => {
    const f = fixture();
    vi.mocked(f.bridge.launch).mockResolvedValue('launched');
    await expect(driveTick(f.deps)).rejects.toThrow('did not persist the launch');
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
    expect(f.bridge.writeStatus).not.toHaveBeenCalled();
  });

  it('releases ownership when reading a control file fails', async () => {
    const f = fixture();
    vi.mocked(f.deps.paused).mockRejectedValue(new Error('control unreadable'));
    await expect(driveTick(f.deps)).rejects.toThrow('control unreadable');
    expect(f.bridge.launch).not.toHaveBeenCalled();
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });

  it('fails closed on a malformed bridge snapshot and releases ownership', async () => {
    const f = fixture();
    vi.mocked(f.bridge.snapshot).mockResolvedValue({ ...f.state, jobs: null } as unknown as DriveSnapshot);
    await expect(driveTick(f.deps)).rejects.toThrow('Invalid drive bridge snapshot');
    expect(f.bridge.launch).not.toHaveBeenCalled();
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });

  it('does nothing for an already stopped tick', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect((await driveTick(f.deps, { signal: controller.signal })).held).toBe('stopping');
    expect(f.calls).toEqual([]);
  });

  it('releases ownership without further actions when shutdown arrives during acquisition', async () => {
    const f = fixture();
    const controller = new AbortController();
    vi.mocked(f.bridge.acquire).mockImplementation(async () => {
      controller.abort();
      return 'lease';
    });
    expect((await driveTick(f.deps, { signal: controller.signal })).held).toBe('stopping');
    expect(f.bridge.reap).not.toHaveBeenCalled();
    expect(f.bridge.snapshot).not.toHaveBeenCalled();
    expect(f.bridge.launch).not.toHaveBeenCalled();
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });

  it.each(['snapshot', 'control'] as const)('does not launch when shutdown arrives during the final %s check', async boundary => {
    const f = fixture();
    const controller = new AbortController();
    if (boundary === 'snapshot') {
      let snapshots = 0;
      vi.mocked(f.bridge.snapshot).mockImplementation(async () => {
        if (++snapshots === 3) controller.abort();
        return structuredClone(f.state);
      });
    } else {
      let checks = 0;
      vi.mocked(f.deps.paused).mockImplementation(async () => {
        if (++checks === 4) controller.abort();
        return false;
      });
    }
    expect(await driveTick(f.deps, { signal: controller.signal })).toMatchObject({ planned: ['next'], launched: [], held: 'stopping' });
    expect(f.bridge.launch).not.toHaveBeenCalled();
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });

  it('settles an interrupted reservation without starting the publisher', async () => {
    const f = fixture([job('done', 'FINISHED'), job('next')]);
    const controller = new AbortController();
    vi.mocked(f.bridge.reservePublish).mockImplementation(async (_lease, id) => {
      f.state.jobs.find(item => item.id === id)!.state = 'PUBLISHING';
      controller.abort();
      return true;
    });
    expect(await driveTick(f.deps, { signal: controller.signal })).toMatchObject({
      published: [], publicationUnknown: ['done'], launched: [], held: 'stopping',
    });
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.bridge.finishPublish).toHaveBeenCalledWith('lease', 'done', 'unknown');
    expect(f.state.jobs[0]!.state).toBe('PUBLISH_UNKNOWN');
    expect(f.bridge.launch).not.toHaveBeenCalled();
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });

  it('stops starting new jobs after shutdown during a launch and releases ownership', async () => {
    const f = fixture([job('first'), job('second')]);
    const controller = new AbortController();
    vi.mocked(f.bridge.launch).mockImplementation(async (_lease, id) => {
      f.state.jobs.find(item => item.id === id)!.state = 'RUNNING';
      controller.abort();
      return 'launched';
    });
    expect(await driveTick(f.deps, { signal: controller.signal })).toMatchObject({ launched: ['first'], held: 'stopping' });
    expect(f.bridge.release).toHaveBeenCalledWith('lease');
  });
});

describe('drive snapshot validation', () => {
  it.each([
    ['missing version', (s: Record<string, unknown>) => { delete s.version; }],
    ['invalid admission', (s: Record<string, unknown>) => { s.admission = 'maybe'; }],
    ['array admission', (s: Record<string, unknown>) => { s.admission = ['open']; }],
    ['negative capacity', (s: Record<string, unknown>) => { s.maxRunning = -1; }],
    ['fractional capacity', (s: Record<string, unknown>) => { s.maxRunning = 1.5; }],
    ['non-finite capacity', (s: Record<string, unknown>) => { s.maxRunning = NaN; }],
    ['floor above ceiling', (s: Record<string, unknown>) => { s.pools = [{ id: 'codex', floor: 3, ceiling: 2 }]; }],
    ['floors above global capacity', (s: Record<string, unknown>) => { s.pools = [{ id: 'codex', floor: 3, ceiling: 3 }]; }],
    ['duplicate pool', (s: Record<string, unknown>) => { s.pools = [fixture().state.pools[0], fixture().state.pools[0]]; }],
    ['duplicate job', (s: Record<string, unknown>) => { s.jobs = [job('same'), job('same')]; }],
    ['unknown pool', (s: Record<string, unknown>) => { s.jobs = [job('next', 'READY', 'unknown')]; }],
    ['path-like job id', (s: Record<string, unknown>) => { s.jobs = [job('../next')]; }],
    ['unknown state', (s: Record<string, unknown>) => { s.jobs = [{ ...job('next'), state: 'COMPLETE' }]; }],
    ['missing completion evidence', (s: Record<string, unknown>) => { s.jobs = [{ ...job('next'), state: 'FINISHED' }]; }],
    ['fractional priority', (s: Record<string, unknown>) => { s.jobs = [job('next', 'READY', 'codex', 1.5)]; }],
  ])('rejects %s', (_name, mutate) => {
    const state = fixture().state as unknown as Record<string, unknown>;
    mutate(state);
    expect(() => parseDriveSnapshot(state)).toThrow('Invalid drive bridge snapshot');
  });

  it('returns a detached snapshot so scheduling cannot mutate bridge state', () => {
    const f = fixture();
    const parsed = parseDriveSnapshot(f.state);
    parsed.jobs[0]!.state = 'RUNNING';
    parsed.pools[0]!.ceiling = 0;
    expect(f.state.jobs[0]!.state).toBe('READY');
    expect(f.state.pools[0]!.ceiling).toBe(2);
  });
});

describe('drive loop', () => {
  it('runs exactly once without sleeping', async () => {
    const f = fixture();
    const sleep = vi.fn(async () => {});
    await driveLoop(f.deps, { once: true, sleep });
    expect(f.bridge.acquire).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('dry-run exits after a single read-only tick even without once', async () => {
    const f = fixture();
    const sleep = vi.fn(async () => {});
    await driveLoop(f.deps, { dryRun: true, sleep });
    expect(f.bridge.snapshot).toHaveBeenCalledTimes(1);
    expect(f.bridge.acquire).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recovers from a transient tick failure after the default 30 second interval', async () => {
    const f = fixture();
    const controller = new AbortController();
    const onError = vi.fn();
    const sleep = vi.fn(async () => {});
    vi.mocked(f.bridge.reap).mockRejectedValueOnce(new Error('temporary failure'));
    const reports = vi.fn(() => controller.abort());
    await driveLoop(f.deps, { signal: controller.signal, error: onError, report: reports, sleep });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(30_000, controller.signal);
    expect(reports).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledTimes(2);
  });

  it('propagates a once failure for a nonzero CLI result', async () => {
    const f = fixture();
    vi.mocked(f.bridge.reap).mockRejectedValue(new Error('unavailable'));
    await expect(driveLoop(f.deps, { once: true })).rejects.toThrow('unavailable');
  });

  it('uses the configured interval and exits when shutdown arrives during sleep', async () => {
    const f = fixture();
    const controller = new AbortController();
    const sleep = vi.fn(async () => { controller.abort(); });
    await driveLoop(f.deps, { tickMs: 5_000, signal: controller.signal, sleep });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000, controller.signal);
    expect(f.bridge.acquire).toHaveBeenCalledTimes(1);
    expect(f.bridge.release).toHaveBeenCalledTimes(1);
  });

  it.each([0, 999, 86_400_001, 1.5, NaN])('rejects invalid interval %s before effects', async tickMs => {
    const f = fixture();
    await expect(driveLoop(f.deps, { once: true, tickMs })).rejects.toThrow('Drive tick');
    expect(f.calls).toEqual([]);
  });
});
