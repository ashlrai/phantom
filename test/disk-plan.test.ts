import { describe, expect, it } from 'vitest';
import {
  buildDiskPlanReport, diskPlanSentence, planRunway, planWorktreeRemoval, WORKTREE_RESULTS,
  type WorktreeRecord,
} from '../src/core/disk-maint/removal-plan.js';
import { cmdDisk, planResultOf, readDiskPlan } from '../src/cli/disk.js';
import { createFleetMemoryApi } from '../src/core/verse/fleet-memory-api.js';
import { diskTrend } from '../src/core/fleet/host-top-view.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const HOUR = 3_600_000;
const GB = 1e9;
const rec = (jobId: string, extra: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  jobId, bytes: 2 * GB, modifiedMs: NOW - 10 * HOUR, result: 'pr-merged', uncommitted: 'no', commitsAhead: 0, ...extra,
});
const plan = (records: WorktreeRecord[], minAgeHours?: number) => planWorktreeRemoval(records, { nowMs: NOW, minAgeHours });
const planned = (records: WorktreeRecord[]) => plan(records).plan.folders.map(f => f.jobId);

describe('planWorktreeRemoval', () => {
  it('puts merged, closed and empty folders in the plan with the GB each frees', () => {
    const r = plan([
      rec('merged-one'),
      rec('closed-one', { result: 'pr-closed', bytes: 3 * GB }),
      rec('empty-one', { result: 'empty', bytes: 0.5 * GB }),
    ]);
    expect(r.plan.folders.map(f => [f.jobId, f.gb])).toEqual([['closed-one', 3], ['merged-one', 2], ['empty-one', 0.5]]);
    expect(r.plan.count).toBe(3);
    expect(r.plan.gb).toBe(5.5);
  });

  it('keeps an open pull request', () => {
    const r = plan([rec('open-one', { result: 'pr-open' })]);
    expect(r.plan.count).toBe(0);
    expect(r.kept).toEqual([{ jobId: 'open-one', gb: 2, result: 'pr-open', reason: 'pull request is still open' }]);
  });

  it('keeps a running job', () => {
    const r = plan([rec('running-one', { result: 'running' })]);
    expect(r.plan.count).toBe(0);
    expect(r.kept[0]!.reason).toBe('job is running');
  });

  it('keeps a folder with uncommitted changes', () => {
    const r = plan([rec('dirty-one', { uncommitted: 'yes' })]);
    expect(r.plan.count).toBe(0);
    expect(r.kept[0]!.reason).toBe('has uncommitted changes');
  });

  it('keeps a folder with commits ahead of base', () => {
    const r = plan([rec('ahead-one', { commitsAhead: 2 })]);
    expect(r.plan.count).toBe(0);
    expect(r.kept[0]!.reason).toBe('2 commits ahead of base');
  });

  it('lists an aborted publish as unpublished work, never in the plan', () => {
    const r = plan([rec('aborted-one', { result: 'publish-aborted' })]);
    expect(r.plan.count).toBe(0);
    expect(r.unpublished.map(f => f.jobId)).toEqual(['aborted-one']);
    expect(r.notSure).toEqual([]);
  });

  it('keeps a folder younger than the age limit, and honours a custom limit', () => {
    const young = rec('young-one', { modifiedMs: NOW - 2 * HOUR });
    expect(planned([young])).toEqual([]);
    expect(plan([young]).kept[0]!.reason).toBe('changed less than 6 hours ago');
    expect(plan([young], 1).plan.count).toBe(1);
  });

  it('lists an unknown size as not sure, with the reason', () => {
    const r = plan([rec('size-one', { bytes: null })]);
    expect(r.plan.count).toBe(0);
    expect(r.notSure).toEqual([{ jobId: 'size-one', gb: null, result: 'pr-merged', reason: 'size unknown' }]);
  });

  it('returns zeros for an empty list', () => {
    const r = plan([]);
    expect(r.folders).toBe(0);
    expect(r.largest).toEqual([]);
    expect(r.plan).toEqual({ folders: [], count: 0, gb: 0 });
    expect(r.notSure).toEqual([]);
    expect(Object.values(r.gbByResult).every(v => v === 0)).toBe(true);
  });

  it('totals GB per result class and lists the ten largest', () => {
    const records = Array.from({ length: 12 }, (_, i) => rec(`job-${String(i).padStart(2, '0')}`, { bytes: (i + 1) * GB }));
    records.push(rec('open-big', { result: 'pr-open', bytes: 50 * GB }));
    const r = plan(records);
    expect(r.gbByResult['pr-merged']).toBe(78);
    expect(r.gbByResult['pr-open']).toBe(50);
    expect(r.countByResult['pr-merged']).toBe(12);
    expect(r.largest).toHaveLength(10);
    expect(r.largest[0]).toEqual({ jobId: 'open-big', gb: 50, result: 'pr-open' });
    expect(r.largest[9]!.jobId).toBe('job-03');
  });

  it('never puts a folder with any unknown field in the plan', () => {
    const unknowns: Array<[string, Partial<WorktreeRecord>]> = [
      ['result', { result: 'unknown' }],
      ['size', { bytes: null }],
      ['time', { modifiedMs: null }],
      ['uncommitted', { uncommitted: 'unknown' }],
      ['ahead', { commitsAhead: null }],
    ];
    const r = plan([rec('known-one'), ...unknowns.map(([name, extra]) => rec(`unknown-${name}`, extra))]);
    expect(r.plan.folders.map(f => f.jobId)).toEqual(['known-one']);
    expect(r.notSure.map(f => f.jobId).sort()).toEqual(unknowns.map(([n]) => `unknown-${n}`).sort());
    for (const item of r.notSure) expect(item.reason).toMatch(/unknown$/);
  });

  it('counts every result class', () => {
    expect(WORKTREE_RESULTS).toHaveLength(7);
    const r = plan(WORKTREE_RESULTS.map(result => rec(`job-${result}`, { result })));
    for (const result of WORKTREE_RESULTS) expect(r.countByResult[result]).toBe(1);
  });
});

describe('runway and sentence', () => {
  const trend = diskTrend([{ at: NOW / 1000 - 3600 * 5, freeGb: 400 }, { at: NOW / 1000, freeGb: 300 }], 100, NOW);

  it('gives hours to the floor now and if the plan were applied', () => {
    const runway = planRunway(trend, 160);
    expect(runway.fallGbPerHour).toBe(20);
    expect(runway.hoursUntilFloorNow).toBe(10);
    expect(runway.hoursUntilFloorIfApplied).toBe(18);
  });

  it('says unknown when there is no trend', () => {
    const runway = planRunway(diskTrend([], 100, NOW), 160);
    expect(runway.hoursUntilFloorNow).toBeNull();
    expect(diskPlanSentence(runway, { folders: [], count: 0, gb: 0 })).toBe('Disk: free space unknown; no finished job folders are safe to remove yet');
  });

  it('opens with one plain sentence', () => {
    const report = buildDiskPlanReport(
      Array.from({ length: 80 }, (_, i) => rec(`job-${i}`, { bytes: 2 * GB })), trend, { nowMs: NOW });
    expect(report.sentence).toBe('Disk: 300 GB free, falling 20 GB an hour, 10 hours to the floor; 80 finished job folders could free about 160 GB');
  });
});

describe('planResultOf', () => {
  it('maps ledger words and leaves unfamiliar ones unknown', () => {
    expect(planResultOf({ state: 'merged', ledgerState: 'merged' })).toBe('pr-merged');
    expect(planResultOf({ state: 'empty', ledgerState: null })).toBe('empty');
    expect(planResultOf({ state: 'open', ledgerState: 'open' })).toBe('pr-open');
    expect(planResultOf({ state: 'none', ledgerState: 'closed' })).toBe('pr-closed');
    expect(planResultOf({ state: 'none', ledgerState: 'running' })).toBe('running');
    expect(planResultOf({ state: 'none', ledgerState: 'publish_aborted_after_push' })).toBe('publish-aborted');
    expect(planResultOf({ state: 'none', ledgerState: 'strange' })).toBe('unknown');
    expect(planResultOf({ state: 'unknown', ledgerState: null })).toBe('unknown');
  });
});

const ledger = [
  { job: 'one', event: 'outcome', state: 'MERGED', ts: '2026-11-18T01:00:00Z' },
  { job: 'two', event: 'outcome', state: 'CLOSED', ts: '2026-11-18T01:00:00Z' },
].map(row => JSON.stringify(row)).join('\n');
const deps = {
  now: NOW, wtRoot: '/wt', runsRoot: '/runs', tmpRoot: '/tmp-x',
  listDirs: (path: string) => { if (path === '/wt') return ['one', 'two', 'three']; throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
  measure: () => ({ bytes: 4 * GB, complete: true }),
  readJobs: () => ({ state: 'healthy' as const, text: ledger }),
  readPins: () => ({ paths: [], valid: true }),
  freeBytes: () => 300 * GB,
  inspect: (dir: string) => ({ modifiedMs: NOW - 10 * HOUR, uncommitted: dir.endsWith('two') ? 'yes' as const : 'no' as const, commitsAhead: 0 }),
  trend: () => diskTrend([{ at: NOW / 1000 - 3600 * 5, freeGb: 400 }, { at: NOW / 1000, freeGb: 300 }], 100, NOW),
};

describe('phm disk --plan', () => {
  it('reads folders, keeps dirty and unrecorded ones, and prints the sentence first', async () => {
    const lines: string[] = [];
    const code = await cmdDisk(['--plan'], { ...deps, output: { log: m => lines.push(m), error: () => {} } });
    expect(code).toBe(0);
    expect(lines[0]).toBe('Disk: 300 GB free, falling 20 GB an hour, 10 hours to the floor; 1 finished job folder could free about 4 GB');
    expect(lines.join('\n')).toContain('Read-only: nothing was removed.');
  });

  it('prints the typed JSON shape', async () => {
    const lines: string[] = [];
    expect(await cmdDisk(['--plan', '--json'], { ...deps, output: { log: m => lines.push(m), error: () => {} } })).toBe(0);
    const json = JSON.parse(lines.join(''));
    expect(Object.keys(json).sort()).toEqual(['gaps', 'generatedAt', 'report', 'runway', 'schema', 'sentence']);
    expect(json.schema).toBe('disk.plan.v1');
    expect(Object.keys(json.runway).sort()).toEqual(['floorGb', 'fallGbPerHour', 'freeGb', 'hoursUntilFloorIfApplied', 'hoursUntilFloorNow'].sort());
    expect(Object.keys(json.report).sort()).toEqual(['countByResult', 'folders', 'gbByResult', 'kept', 'largest', 'minAgeHours', 'notSure', 'plan', 'schema', 'unpublished']);
    expect(json.report.plan.folders.map((f: { jobId: string }) => f.jobId)).toEqual(['one']);
    expect(json.report.kept.map((f: { jobId: string }) => f.jobId)).toEqual(['two']);
    expect(json.report.notSure.map((f: { jobId: string }) => f.jobId)).toEqual(['three']);
  });

  it('turns unreadable git facts into unknown, not into the plan', async () => {
    const report = await readDiskPlan({ ...deps, inspect: () => { throw new Error('no git'); } });
    expect(report.report.plan.count).toBe(0);
    expect(report.report.notSure).toHaveLength(3);
  });

  it('rejects --min-age-hours without --plan', async () => {
    const errors: string[] = [];
    expect(await cmdDisk(['--min-age-hours', '2'], { ...deps, output: { log: () => {}, error: m => errors.push(m) } })).toBe(2);
    expect(errors[0]).toContain('--plan');
  });
});

describe('disk-plan route', () => {
  it('serves the same report on GET and refuses other methods', async () => {
    const report = await readDiskPlan(deps);
    const api = createFleetMemoryApi({ readDiskPlan: async () => report });
    const send = async (method: string) => {
      let status = 0; let body = '';
      const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; }, setHeader: () => {} };
      const handled = await api({} as never, { url: '/x' } as never, res as never, '/api/verse/fleet/memory/disk-plan', method);
      return { handled, status, body };
    };
    const ok = await send('GET');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).sentence).toBe(report.sentence);
    expect((await send('POST')).status).toBe(405);
  });
});
