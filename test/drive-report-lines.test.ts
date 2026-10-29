import { describe, expect, it, vi } from 'vitest';
import {
  driveTick, parseDriveSnapshot, planDrive,
  type DriveBridge, type DriveDependencies, type DriveJob, type DriveSnapshot,
} from '../src/core/drive/supervisor.js';
import { isReportOnlyLine, VERIFY_PR_FAMILY } from '../src/core/drive/report-lines.js';

function job(id: string, state: DriveJob['state'] = 'READY', pool = 'devin', priority = 0): DriveJob {
  return { id, state, pool, priority, ...(state === 'FINISHED' ? { exitCode: 0 } : {}) };
}

function fixture(jobs: DriveJob[] = [job('next')]) {
  const state: DriveSnapshot = {
    version: 1, pools: [{ id: 'devin', floor: 0, ceiling: 2 }], maxRunning: 2,
    paused: false, admission: 'open', jobs,
  };
  const calls: string[] = [];
  const bridge: DriveBridge = {
    snapshot: vi.fn(async () => structuredClone(state)),
    acquire: vi.fn(async () => 'lease'),
    reap: vi.fn(async () => {}),
    launch: vi.fn(async (_lease, id) => {
      calls.push(`launch:${id}`);
      state.jobs.find(item => item.id === id)!.state = 'RUNNING';
      return 'launched';
    }),
    reservePublish: vi.fn(async (_lease, id) => {
      calls.push(`reserve:${id}`);
      state.jobs.find(item => item.id === id)!.state = 'PUBLISHING';
      return true;
    }),
    finishPublish: vi.fn(async (_lease, id, outcome) => {
      calls.push(`finish:${id}:${outcome}`);
      state.jobs.find(item => item.id === id)!.state = outcome === 'published' ? 'PUBLISHED' : 'PUBLISH_UNKNOWN';
    }),
    report: vi.fn(async (_lease, id) => {
      calls.push(`report:${id}`);
      state.jobs.find(item => item.id === id)!.state = 'REPORTED';
    }),
    writeStatus: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const deps: DriveDependencies = {
    bridge, paused: vi.fn(async () => false), publish: vi.fn(async id => { calls.push(`publish:${id}`); }),
    now: () => new Date('2026-10-28T12:00:00Z'),
  };
  return { state, bridge, deps, calls };
}

describe('report-only line family detection', () => {
  it.each([
    'RQ-VERIFY-PR985', 'RQ-VERIFY-PR1059', 'RQ-VERIFY-PR1063', 'RQ-VERIFY-PR1088',
    'RQ-VERIFY-PR1089', 'RQ-VERIFY-PR1095', 'RQ-VERIFY-PR-42', 'VERIFY-PR985',
    'VERIFY-PR-12', 'RQ-VERIFY-PR',
  ])('routes %s to report-only', id => {
    expect(isReportOnlyLine(id), id).toBe(true);
    expect(VERIFY_PR_FAMILY).toBe('VERIFY-PR');
  });

  it.each([
    'RQ-VERIFY', 'VERIFY', 'RQ-VERIFY-PROD', 'RQ-MR-PARK-VERIFY-PR',
    'rq-verify-pr985', 'RQ-verify-pr42', 'X-VERIFY-PR1', 'RQ-GEN-1', 'next',
    'RQ-VERIFY-PRA',
  ])('keeps %s on the normal route', id => {
    expect(isReportOnlyLine(id), id).toBe(false);
  });
});

describe('dispatchd report-only routing: VERIFY-PR lines', () => {
  it('routes a READY VERIFY-PR line to report-only — it never launches, never publishes, never counts as EMPTY_DONE', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-MR-OTHER-1')]);
    const report = await driveTick(f.deps);
    expect(report.reported).toEqual(['RQ-VERIFY-PR1088']);
    expect(report.launched).toEqual(['RQ-MR-OTHER-1']);
    expect(f.calls).toEqual(['report:RQ-VERIFY-PR1088', 'launch:RQ-MR-OTHER-1']);
    // No publication path was touched for the verification line.
    expect(f.calls.some(c => c.startsWith('reserve:RQ-VERIFY') || c.startsWith('publish:RQ-VERIFY') || c.startsWith('finish:RQ-VERIFY'))).toBe(false);
    expect(report.published).toEqual([]);
    expect(f.state.jobs[0]!.state).toBe('REPORTED');
  });

  it('settles a cleanly FINISHED VERIFY-PR job through report, not publish.sh', async () => {
    const f = fixture([job('RQ-VERIFY-PR1063', 'FINISHED'), job('RQ-MR-OTHER-1', 'FINISHED')]);
    const report = await driveTick(f.deps);
    expect(report.reported).toEqual(['RQ-VERIFY-PR1063']);
    expect(report.published).toEqual(['RQ-MR-OTHER-1']);
    expect(f.calls).toEqual(['report:RQ-VERIFY-PR1063', 'reserve:RQ-MR-OTHER-1', 'publish:RQ-MR-OTHER-1', 'finish:RQ-MR-OTHER-1:published']);
    expect(f.state.jobs[0]!.state).toBe('REPORTED');
  });

  it('never reports a failed VERIFY-PR run — the failure evidence stands', async () => {
    const f = fixture([{ ...job('RQ-VERIFY-PR985', 'FINISHED'), exitCode: 3 }]);
    const report = await driveTick(f.deps);
    expect(report.reported).toEqual([]);
    expect(report.published).toEqual([]);
    expect(f.bridge.report).not.toHaveBeenCalled();
    expect(f.deps.publish).not.toHaveBeenCalled();
  });

  it('leaves HELD, STARTING, RUNNING and quarantined VERIFY-PR lines untouched', async () => {
    const f = fixture([
      job('RQ-VERIFY-PR1', 'HELD'),
      job('RQ-VERIFY-PR2', 'STARTING'),
      job('RQ-VERIFY-PR3', 'RUNNING'),
      job('RQ-VERIFY-PR4', 'PUBLISHING'),
      job('RQ-VERIFY-PR5', 'PUBLISH_UNKNOWN'),
    ]);
    const report = await driveTick(f.deps);
    expect(report.reported).toEqual([]);
    expect(f.bridge.report).not.toHaveBeenCalled();
    expect(f.state.jobs.map(j => j.state)).toEqual(['HELD', 'STARTING', 'RUNNING', 'PUBLISHING', 'PUBLISH_UNKNOWN']);
  });

  it('parks the family when the bridge has no report step — parked is never published', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-MR-OTHER-1')]);
    delete (f.bridge as { report?: unknown }).report;
    const report = await driveTick(f.deps);
    expect(report.reported).toEqual([]);
    expect(report.launched).toEqual(['RQ-MR-OTHER-1']);
    expect(f.calls).toEqual(['launch:RQ-MR-OTHER-1']);
    expect(f.state.jobs[0]!.state).toBe('READY');
  });

  it('keeps REPORTED lines out of every later tick — a report is settled once', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088')]);
    await driveTick(f.deps);
    expect(f.state.jobs[0]!.state).toBe('REPORTED');
    const second = await driveTick(f.deps);
    expect(second.reported).toEqual([]);
    expect(f.bridge.report).toHaveBeenCalledTimes(1);
  });

  it('admits REPORTED in the snapshot and never counts it active, ready or launchable', () => {
    const f = fixture([{ ...job('RQ-VERIFY-PR1088'), state: 'REPORTED' }]);
    const parsed = parseDriveSnapshot(f.state);
    expect(parsed.jobs[0]!.state).toBe('REPORTED');
    expect(planDrive(f.state)).toEqual([]);
  });

  it('a VERIFY-PR line is never a launch candidate even when lanes are free', () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-VERIFY-PR1095'), job('RQ-MR-OTHER-1')]);
    expect(planDrive(f.state)).toEqual(['RQ-MR-OTHER-1']);
  });

  it('dry-run settles nothing: no report, no publish, read-only snapshot', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-MR-OTHER-1')]);
    const report = await driveTick(f.deps, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, reported: [], published: [], launched: [] });
    expect(f.bridge.report).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('still reports under memory pause — only launches are held', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-MR-OTHER-1')]);
    vi.mocked(f.deps.paused).mockResolvedValue(true);
    const report = await driveTick(f.deps);
    expect(report).toMatchObject({ paused: true, reported: ['RQ-VERIFY-PR1088'], launched: [] });
    expect(f.bridge.launch).not.toHaveBeenCalled();
  });

  it('a failed report propagates like every other bridge mutation — nothing is faked published', async () => {
    const f = fixture([job('RQ-VERIFY-PR1088'), job('RQ-MR-OTHER-1', 'FINISHED')]);
    vi.mocked(f.bridge.report!).mockRejectedValue(new Error('report store unavailable'));
    await expect(driveTick(f.deps)).rejects.toThrow('report store unavailable');
    expect(f.state.jobs[0]!.state).toBe('READY');
    expect(f.deps.publish).not.toHaveBeenCalled();
  });
});
