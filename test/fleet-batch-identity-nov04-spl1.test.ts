import { expect, it, vi } from 'vitest';
import { precheckJobBatch } from '../src/core/fleet/job-precheck-batch.js';

it('uses each explicit identity independently while sharing git facts', async () => {
  const git = {
    exists: vi.fn(async () => true),
    lastCommit: vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-ONE): landed' })),
  };
  const ids: Record<string, string> = { first: 'RQ-ONE', second: 'RQ-TWO' };
  const result = await precheckJobBatch(['first', 'second', 'legacy'], {
    readFile: async () => 'src/shared.ts', git, jobIdForFile: file => ids[file],
  });
  expect(result.entries.map(entry => entry.report?.verdict)).toEqual(['likely-done', 'partly-on-master', 'likely-done']);
  expect(result.entries.map(entry => entry.report?.facts[0]?.jobIdMatch)).toEqual([true, false, undefined]);
  expect(result.entries.map(entry => entry.report?.jobId)).toEqual(['RQ-ONE', 'RQ-TWO', undefined]);
  expect(result.counts).toEqual({ fresh: 0, 'partly-on-master': 1, 'likely-done': 2, errors: 0 });
  expect(result.collisions).toEqual([{ path: 'src/shared.ts', files: ['first', 'second', 'legacy'] }]);
  expect(git.exists).toHaveBeenCalledTimes(1);
  expect(git.lastCommit).toHaveBeenCalledTimes(1);
});

it('keeps absent commits and missing paths unknown, and preserves legacy calls', async () => {
  const git = { exists: vi.fn(async (path: string) => path === 'src/existing.ts'), lastCommit: vi.fn(async () => null) };
  const result = await precheckJobBatch(['identified', 'legacy'], {
    readFile: async () => 'RQ-ONE src/existing.ts src/missing.ts', git,
    jobIdForFile: file => file === 'identified' ? 'RQ-ONE' : undefined,
  });
  expect(result.entries[0]?.report?.facts.map(f => f.jobIdMatch)).toEqual([null, null]);
  expect(result.entries[0]?.report?.verdict).toBe('partly-on-master');
  const legacy = await precheckJobBatch(['legacy'], { readFile: async () => 'RQ-ONE src/existing.ts src/missing.ts', git });
  expect(result.entries[1]?.report).toEqual(legacy.entries[0]?.report);
});
