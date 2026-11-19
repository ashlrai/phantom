import { describe, expect, it } from 'vitest';
import { planWorktreeRemoval, type WorktreeRecord } from '../src/core/disk-maint/removal-plan.js';

// In-memory fixtures for `phm disk --plan` (planWorktreeRemoval). No disk access.
const NOW = Date.parse('2026-11-18T12:00:00Z');
const HOUR = 3_600_000;
const GB = 1e9;

const folder = (jobId: string, extra: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  jobId, bytes: 1 * GB, modifiedMs: NOW - 10 * HOUR, result: 'pr-merged', uncommitted: 'no', commitsAhead: 0, ...extra,
});

const planFor = (records: WorktreeRecord[]) => planWorktreeRemoval(records, { nowMs: NOW });
const safeIds = (records: WorktreeRecord[]) => planFor(records).plan.folders.map(f => f.jobId);

describe('planWorktreeRemoval safe-to-remove rules', () => {
  it('lists an empty job folder older than 6 hours as safe', () => {
    const records = [folder('empty-old', { result: 'empty', bytes: 0, modifiedMs: NOW - 7 * HOUR })];
    const report = planFor(records);
    expect(report.plan.folders).toEqual([{ jobId: 'empty-old', gb: 0, result: 'empty' }]);
    expect(report.kept).toEqual([]);
    expect(report.notSure).toEqual([]);
  });

  it('never lists a folder with uncommitted changes as safe', () => {
    // Otherwise-safe folders: each would be planned if its only problem were absent.
    const records = [
      folder('dirty-merged', { uncommitted: 'yes' }),
      folder('dirty-empty', { result: 'empty', bytes: 0, uncommitted: 'yes' }),
      folder('dirty-closed', { result: 'pr-closed', uncommitted: 'yes' }),
    ];
    expect(safeIds(records)).toEqual([]);
    const report = planFor(records);
    expect(report.kept.map(k => [k.jobId, k.reason]).sort()).toEqual([
      ['dirty-closed', 'has uncommitted changes'],
      ['dirty-empty', 'has uncommitted changes'],
      ['dirty-merged', 'has uncommitted changes'],
    ]);
  });

  it('never lists a folder whose job is still running as safe', () => {
    // Running wins even when the folder is old, clean and in a finished-looking result.
    const records = [
      folder('running-old', { result: 'running', modifiedMs: NOW - 48 * HOUR }),
      folder('running-empty', { result: 'running', bytes: 0, uncommitted: 'no' }),
    ];
    expect(safeIds(records)).toEqual([]);
    const report = planFor(records);
    expect(report.kept.map(k => [k.jobId, k.reason]).sort()).toEqual([
      ['running-empty', 'job is running'],
      ['running-old', 'job is running'],
    ]);
  });
});
