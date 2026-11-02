import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJobPairCompare } from '../examples/agents/job-pair-compare.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';

const time = '2026-01-01T00:00:00.000Z';
const detail = (job: string): FleetJobDetailV1 => ({
  schema: 'fleet.job.v1', generatedAt: time, job, state: 'archived', lane: 'fake-lane', model: 'fake-model',
  tier: null, pid: null, launchedAt: null, baseSha: null, branch: null, promptBytes: null, publish: null,
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'missing', bytes: null, tail: [], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'missing', log: 'missing' },
});
const changes = (job: string, paths: string[]): FleetJobChangesV1 => ({
  schema: 'fleet.job.changes.v1', generatedAt: time, job, state: 'live', baseSha: 'abcdef1',
  files: paths.map(path => ({ path, added: 1, removed: 2, status: 'modified' })),
  totals: { files: paths.length, added: paths.length, removed: paths.length * 2 }, truncated: false,
});
async function compare(before: FleetJobDetailV1, after: FleetJobDetailV1, old: FleetJobChangesV1, current: FleetJobChangesV1) {
  let output = '';
  const readDetail = vi.fn(async (id: string) => id === before.job ? before : after);
  const readChanges = vi.fn(async (id: string) => id === old.job ? old : current);
  const code = await runJobPairCompare(['--after', after.job, '--before', before.job], {
    readDetail, readChanges, write: text => { output += text; },
  });
  return { code, value: JSON.parse(output), output, readDetail, readChanges };
}

describe('job pair artifact comparison', () => {
  it('reads each job and compares distinct and common paths without inventing a verdict', async () => {
    const before = detail('JOB-BEFORE'), after = detail('JOB-AFTER');
    before.publish = { prUrl: null, testLine: 'TEST failed', autoMerge: null, sensitive: null };
    before.sources.publish = 'healthy';
    after.state = 'published'; after.sources.publish = 'healthy';
    after.publish = { prUrl: 'https://example.invalid/pull/42', testLine: 'TEST passed', autoMerge: true, sensitive: null };
    const result = await compare(before, after, changes(before.job, ['old.ts', 'both.ts']), changes(after.job, ['new.ts', 'both.ts']));
    expect(result.code).toBe(0);
    expect(result.readDetail.mock.calls).toEqual([[before.job], [after.job]]);
    expect(result.readChanges.mock.calls).toEqual([[before.job], [after.job]]);
    expect(result.value).toMatchObject({ schema: 'fleet.job-pair-compare.v1',
      before: { lane: 'fake-lane', model: 'fake-model', artifactState: 'archived', testLine: 'TEST failed', prUrl: null },
      after: { artifactState: 'published', testLine: 'TEST passed', prUrl: 'https://example.invalid/pull/42', sources: { publish: 'healthy' } },
      changedFiles: { complete: true, added: ['new.ts'], removed: ['old.ts'], common: ['both.ts'] },
    });
    expect(result.value).not.toHaveProperty('success');
    expect(result.value.after).not.toHaveProperty('verdict');
  });

  it('preserves missing predecessor evidence instead of treating it as an empty known diff', async () => {
    const before = detail('JOB-BEFORE'), after = detail('JOB-AFTER');
    before.state = 'unknown'; before.lane = null; before.model = null;
    before.sources = { launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing' };
    const old = changes(before.job, []); old.state = 'missing';
    const result = await compare(before, after, old, changes(after.job, ['new.ts']));
    expect(result.value.before).toMatchObject({ artifactState: 'unknown', testLine: null, prUrl: null,
      sources: { changes: 'missing' }, changes: { observedTotals: null } });
    expect(result.value.changedFiles).toEqual({ complete: false, added: ['new.ts'], removed: [], common: [] });
  });

  it('marks truncated and degraded sets incomplete and preserves unknown line counts', async () => {
    const before = detail('JOB-BEFORE'), after = detail('JOB-AFTER');
    const old = changes(before.job, ['binary.dat']); old.truncated = true; old.files[0]!.added = null; old.files[0]!.removed = null;
    const current = changes(after.job, ['binary.dat', 'new.ts']); current.state = 'degraded'; current.comparisonBase = 'HEAD';
    const result = await compare(before, after, old, current);
    expect(result.value.before.changes).toMatchObject({ truncated: true, observedTotals: { files: 1, added: null, removed: null } });
    expect(result.value.after.changes.comparisonBase).toBe('HEAD');
    expect(result.value.changedFiles).toEqual({ complete: false, added: ['new.ts'], removed: [], common: ['binary.dat'] });
  });

  it('composes actual readers and distinguishes publish artifact evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-pair-fake-'));
    try {
      await writeFile(join(dir, 'JOB-AFTER.publish'), 'RESULT PR https://example.invalid/pull/3\nTEST passed\n');
      await writeFile(join(dir, 'JOB-AFTER.base.meta'), 'MODEL fake-lane fake-tier fake-model\n');
      let output = '';
      const code = await runJobPairCompare(['--before', 'JOB-BEFORE', '--after', 'JOB-AFTER'], {
        readDetail: id => getFleetJobDetail(id, { runsDir: dir }),
        readChanges: id => getFleetJobChanges(id, { runsDir: dir, homeDir: dir }),
        write: text => { output += text; },
      });
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        before: { artifactState: 'unknown', sources: { publish: 'missing', changes: 'missing' } },
        after: { artifactState: 'published', lane: 'fake-lane', model: 'fake-model',
          testLine: 'TEST passed', prUrl: 'https://example.invalid/pull/3', sources: { publish: 'healthy' } },
        changedFiles: { complete: false },
      });
      expect(output).not.toContain(dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('accepts help and emits stable JSON errors without calling readers or leaking exceptions', async () => {
    let output = '';
    const write = (text: string) => { output += text; };
    const readDetail = vi.fn(async () => { throw new Error('/fake/private/path'); });
    expect(await runJobPairCompare(['--help'], { write })).toBe(0);
    expect(output).toContain('--before ID --after ID');
    output = '';
    expect(await runJobPairCompare(['--before', 'JOB-ONE', '--before', 'JOB-TWO'], { write, readDetail })).toBe(2);
    expect(JSON.parse(output)).toEqual({ schema: 'fleet.job-pair-compare.error.v1', error: 'invalid_arguments' });
    expect(readDetail).not.toHaveBeenCalled();
    output = '';
    expect(await runJobPairCompare(['--before', 'JOB-ONE', '--after', 'JOB-TWO'], {
      write, readDetail, readChanges: async id => changes(id, []),
    })).toBe(1);
    expect(JSON.parse(output)).toEqual({ schema: 'fleet.job-pair-compare.error.v1', error: 'reader_unavailable' });
    expect(output).not.toContain('/fake/private/path');
  });
});
