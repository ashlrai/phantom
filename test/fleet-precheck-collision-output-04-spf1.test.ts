import { expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';

const oid = 'a'.repeat(40);

function fixture(drafts: Record<string, string>, failingPath?: string) {
  const log = vi.fn();
  const error = vi.fn();
  const git = {
    exists: vi.fn(async (path: string) => {
      if (path === failingPath) throw new Error('probe failed');
      return false;
    }),
    lastCommit: vi.fn(async () => null),
  };
  const deps = {
    git, log, error,
    resolveRef: async () => oid,
    readFile: async (path: string) => {
      if (!(path in drafts)) throw new Error('missing');
      return drafts[path]!;
    },
  };
  return { deps, git, log, error };
}

it('prints sorted collision evidence in JSON and text without changing success or caching', async () => {
  const drafts = { 'b.md': 'src/shared.ts docs/shared.md', 'a.md': 'src/shared.ts docs/shared.md' };
  const json = fixture(drafts);
  expect(await cmdFleetJobPrecheck(['--batch', 'b.md', 'a.md', '--json'], json.deps)).toBe(0);
  const output = JSON.parse(json.log.mock.calls[0]![0] as string);
  expect(output).toMatchObject({
    schema: 'fleet.job-precheck-batch.v1', ref: 'origin/master', resolvedRef: oid,
    counts: { fresh: 2, 'partly-on-master': 0, 'likely-done': 0, errors: 0 },
    collisions: [
      { path: 'docs/shared.md', files: ['b.md', 'a.md'] },
      { path: 'src/shared.ts', files: ['b.md', 'a.md'] },
    ],
  });
  expect(output.results.map((entry: { file: string }) => entry.file)).toEqual(['b.md', 'a.md']);
  expect(json.git.exists.mock.calls.map(call => call[0])).toEqual(['src/shared.ts', 'docs/shared.md']);
  expect(json.git.lastCommit).not.toHaveBeenCalled();
  const text = fixture(drafts);
  expect(await cmdFleetJobPrecheck(['--batch', 'b.md', 'a.md'], text.deps)).toBe(0);
  expect(text.log.mock.calls.flat().join('\n')).toContain('collision (evidence only): src/shared.ts — b.md, a.md');
});

it('returns an empty collision array for disjoint drafts', async () => {
  const f = fixture({ 'a.md': 'src/a.ts', 'b.md': 'src/b.ts' });
  expect(await cmdFleetJobPrecheck(['--batch', 'a.md', 'b.md', '--json'], f.deps)).toBe(0);
  expect(JSON.parse(f.log.mock.calls[0]![0] as string).collisions).toEqual([]);
});

it('retains error exit and excludes failed draft facts from collision evidence', async () => {
  const f = fixture({ 'a.md': 'src/shared.ts src/boom.ts', 'b.md': 'src/shared.ts' }, 'src/boom.ts');
  expect(await cmdFleetJobPrecheck(['--batch', 'a.md', 'b.md', '--json'], f.deps)).toBe(2);
  const output = JSON.parse(f.log.mock.calls[0]![0] as string);
  expect(output.collisions).toEqual([]);
  expect(output.counts.errors).toBe(1);
  expect(output.results[0]).toEqual({ file: 'a.md', error: 'probe failed' });
});

it('describes collision evidence in help', async () => {
  const f = fixture({});
  expect(await cmdFleetJobPrecheck(['--help'], f.deps)).toBe(0);
  expect(f.log.mock.calls.flat().join('\n')).toContain('Collisions do not change the exit status');
});
