import { expect, it, vi } from 'vitest';
import { precheckJobBatch } from '../src/core/fleet/job-precheck-batch.js';
import type { JobPrecheckGit } from '../src/core/fleet/job-precheck.js';

/** Map-backed draft store; filenames are the strings a caller would pass. */
function drafts(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path) => {
    const body = files[path];
    if (body === undefined) throw new Error(`ENOENT: no such file ${path}`);
    return body;
  };
}

/** Fake adapter: paths in `master` exist; each maps to its last-commit subject. */
function fakeGit(master: Record<string, string>): JobPrecheckGit & { exists: ReturnType<typeof vi.fn>; lastCommit: ReturnType<typeof vi.fn> } {
  return {
    exists: vi.fn(async (path: string) => Object.prototype.hasOwnProperty.call(master, path)),
    lastCommit: vi.fn(async (path: string) => {
      const subject = master[path];
      return subject ? { sha: 'abc1234', subject } : null;
    }),
  };
}

it('reports one collision when two drafts name the same implementation file', async () => {
  const result = await precheckJobBatch(['a.md', 'b.md', 'c.md'], {
    readFile: drafts({
      'a.md': 'Edit src/shared.ts and docs/guide.md\n',
      'b.md': 'Touch src/shared.ts plus scripts/run.mjs\n',
      'c.md': 'Create src/only-c.ts\n',
    }),
    git: fakeGit({}),
  });
  expect(result.collisions).toEqual([
    { path: 'src/shared.ts', files: ['a.md', 'b.md'] },
  ]);
  expect(result.entries.map(entry => entry.file)).toEqual(['a.md', 'b.md', 'c.md']);
  expect(result.counts).toEqual({ fresh: 3, 'partly-on-master': 0, 'likely-done': 0, errors: 0 });
});

it('sorts collision records by path and lists drafts in input order', async () => {
  const result = await precheckJobBatch(['b.md', 'a.md'], {
    readFile: drafts({
      'b.md': 'src/shared.ts docs/early.md\n',
      'a.md': 'src/shared.ts docs/early.md src/only-a.ts\n',
    }),
    git: fakeGit({}),
  });
  // b.md mentions src/shared.ts first, but docs/early.md still sorts first.
  expect(result.collisions).toEqual([
    { path: 'docs/early.md', files: ['b.md', 'a.md'] },
    { path: 'src/shared.ts', files: ['b.md', 'a.md'] },
  ]);
});

it('emits no collisions for disjoint drafts', async () => {
  const result = await precheckJobBatch(['a.md', 'b.md'], {
    readFile: drafts({ 'a.md': 'src/a.ts\n', 'b.md': 'src/b.ts docs/b.md\n' }),
    git: fakeGit({}),
  });
  expect(result.collisions).toEqual([]);
  expect(result.entries.every(entry => entry.report?.verdict === 'fresh')).toBe(true);
});

it('ignores test and spec paths shared across drafts', async () => {
  const result = await precheckJobBatch(['a.md', 'b.md'], {
    readFile: drafts({
      'a.md': 'test/shared.test.ts src/x.spec.ts src/only-a.ts\n',
      'b.md': 'test/shared.test.ts src/x.spec.ts src/only-b.ts\n',
    }),
    git: fakeGit({}),
  });
  // The shared paths were real extracted facts; they are simply not implementation files.
  expect(result.entries[0]!.report!.facts.map(fact => fact.path)).toEqual([
    'test/shared.test.ts', 'src/x.spec.ts', 'src/only-a.ts',
  ]);
  expect(result.collisions).toEqual([]);
});

it('never collides a draft with itself over repeated arguments or mentions', async () => {
  const same = await precheckJobBatch(['a.md', 'a.md'], {
    readFile: drafts({ 'a.md': 'src/shared.ts then src/shared.ts again\n' }),
    git: fakeGit({}),
  });
  expect(same.entries).toHaveLength(2);
  expect(same.collisions).toEqual([]);

  const mixed = await precheckJobBatch(['a.md', 'b.md', 'a.md'], {
    readFile: drafts({ 'a.md': 'src/shared.ts\n', 'b.md': 'src/shared.ts\n' }),
    git: fakeGit({}),
  });
  expect(mixed.entries).toHaveLength(3);
  expect(mixed.collisions).toEqual([{ path: 'src/shared.ts', files: ['a.md', 'b.md'] }]);
});

it('keeps read and probe failures as errors and out of collision evidence', async () => {
  const git = fakeGit({});
  const unreadable = await precheckJobBatch(['a.md', 'absent.md', 'b.md'], {
    readFile: drafts({ 'a.md': 'src/shared.ts src/only-a.ts\n', 'b.md': 'src/shared.ts\n' }),
    git,
  });
  expect(unreadable.entries.map(entry => entry.file)).toEqual(['a.md', 'absent.md', 'b.md']);
  expect(unreadable.entries[1]!.error).toBe('cannot read absent.md');
  expect(unreadable.entries[1]!.report).toBeUndefined();
  expect(unreadable.counts.errors).toBe(1);
  expect(unreadable.collisions).toEqual([{ path: 'src/shared.ts', files: ['a.md', 'b.md'] }]);

  // A draft whose probe fails contributes no facts, so it cannot collide.
  const failing: JobPrecheckGit = {
    async exists(path: string) {
      if (path === 'src/boom.ts') throw new Error('fatal: bad revision');
      return false;
    },
    async lastCommit() { return null; },
  };
  const probed = await precheckJobBatch(['a.md', 'b.md', 'c.md'], {
    readFile: drafts({
      'a.md': 'src/boom.ts\n',
      'b.md': 'src/boom.ts src/shared.ts\n',
      'c.md': 'src/shared.ts\n',
    }),
    git: failing,
  });
  expect(probed.entries.map(entry => entry.error !== undefined)).toEqual([true, true, false]);
  expect(probed.counts).toEqual({ fresh: 1, 'partly-on-master': 0, 'likely-done': 0, errors: 2 });
  expect(probed.collisions).toEqual([]);
});

it('probes a colliding path once across drafts and keeps verdicts intact', async () => {
  const git = fakeGit({ 'src/shared.ts': 'bridge(RQ-PHX-SPD1): landed' });
  const result = await precheckJobBatch(['a.md', 'b.md'], {
    readFile: drafts({ 'a.md': 'Edit src/shared.ts\n', 'b.md': 'Again src/shared.ts\n' }),
    git,
  });
  expect(result.collisions).toEqual([{ path: 'src/shared.ts', files: ['a.md', 'b.md'] }]);
  expect(git.exists.mock.calls.map(call => call[0])).toEqual(['src/shared.ts']);
  expect(git.lastCommit.mock.calls.map(call => call[0])).toEqual(['src/shared.ts']);
  expect(result.entries.map(entry => entry.report?.verdict)).toEqual(['likely-done', 'likely-done']);
});
