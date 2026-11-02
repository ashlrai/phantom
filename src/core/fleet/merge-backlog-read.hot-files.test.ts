import { expect, it } from 'vitest';
import { readMergeBacklog } from './merge-backlog-read.js';

it('counts distinct dirty and open PRs using bounded files and one bounded read', async () => {
  const rows = [1, 2, 3, 4].map(number => ({ number, mergeStateStatus: number < 3 ? 'DIRTY' : 'CLEAN',
    files: [{ path: 'src/shared.ts' }, ...Array.from({ length: 310 }, (_, i) => ({ path: i === 50 ? 'src/zshared-late.ts' : i === 300 ? 'aaa-overflow.ts' : `src/file${number}-${i}.ts` }))] }));
  const read = await readMergeBacklog({ repo: 'fake/repo', states: () => new Map(), gh: async args => {
    expect(args).toContain('100'); expect(args.at(-1)).toContain('files');
    return { ok: true, stdout: JSON.stringify(rows), stderr: '' };
  } });
  expect(read.hotFiles?.[0]).toEqual({ path: 'src/shared.ts', dirtyPrs: 2, openPrs: 4 });
  expect(read.items).toHaveLength(4);
  expect(read.items[0]?.files).toHaveLength(30);
  expect(read.hotFiles?.some(file => file.path === 'aaa-overflow.ts')).toBe(false);
  expect(read.hotFiles?.find(file => file.path === 'src/zshared-late.ts')).toMatchObject({ dirtyPrs: 2, openPrs: 4 });
});

it('keeps hot files undefined after a failed GitHub read', async () => {
  const read = await readMergeBacklog({ repo: 'fake/repo', gh: async () => ({ ok: false, stdout: '', stderr: 'fake failure' }) });
  expect(read.hotFiles).toBeUndefined();
  expect(read.error).toBe(read.reason);
});

it('does not consume more PRs than the requested limit', async () => {
  const read = await readMergeBacklog({ repo: 'fake/repo', limit: 1, states: () => new Map(), gh: async () => ({ ok: true, stdout: JSON.stringify([{ number: 1 }, { number: 2 }]), stderr: '' }) });
  expect(read.items.map(item => item.number)).toEqual([1]);
});
