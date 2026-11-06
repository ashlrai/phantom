import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetWtReap, type WtReapDeps } from '../src/cli/fleet-wt-reap.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reap-apply-'));
  roots.push(root);
  const now = Date.parse('2026-11-02T12:00:00Z');
  await mkdir(join(root, 'metrics'));
  for (const id of ['merged', 'empty', 'open', 'recent', 'unknown']) await mkdir(join(root, 'wt', id), { recursive: true });
  const rows = ['merged', 'empty', 'open', 'recent'].flatMap(job => [
    { event: 'finish', job, empty: job === 'empty', ts: new Date(now - (job === 'recent' ? 1000 : 7_200_000)).toISOString() },
    ...(job === 'empty' ? [] : [{ event: 'outcome', job, state: job === 'open' ? 'open' : 'merged' }]),
  ]);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const logs: string[] = [];
  const calls: string[][] = [];
  const deps: WtReapDeps = { runsRoot: root, now, output: { log: s => logs.push(s), error: s => logs.push(s) },
    runner: async (file, args) => { expect(file).toBe('git'); calls.push(args); await rm(args.at(-1)!, { recursive: true }); } };
  return { root, deps, logs, calls };
}
it('previews the same list by default and removes only reapable fixture dirs on apply', async () => {
  const { root, deps, logs, calls } = await fixture();
  expect(await cmdFleetWtReap(['--json'], deps)).toBe(0);
  const preview = JSON.parse(logs.pop()!);
  expect(calls).toEqual([]);
  expect(await readdir(join(root, 'wt'))).toHaveLength(5);
  expect(await cmdFleetWtReap(['--apply', '--json'], deps)).toBe(0);
  const applied = JSON.parse(logs.pop()!);
  expect(applied.worktrees).toEqual(preview.worktrees);
  expect(applied.readOnly).toBe(false);
  expect(applied.removals).toEqual([{ id: 'empty', status: 'removed' }, { id: 'merged', status: 'removed' }]);
  expect(calls).toEqual(['empty', 'merged'].map(id => ['-C', join(root, 'wt', id), 'worktree', 'remove', '--', join(root, 'wt', id)]));
  expect(await readdir(join(root, 'wt'))).toEqual(['open', 'recent', 'unknown']);
});
it('refuses outside paths from an injected directory reader without running Git', async () => {
  const { root, deps, logs, calls } = await fixture();
  await mkdir(join(root, 'outside'));
  deps.readers = { listDirs: async () => ['../outside', join(root, 'outside')], readJobs: async () => '' };
  expect(await cmdFleetWtReap(['--apply', '--json'], deps)).toBe(1);
  expect(JSON.parse(logs.pop()!).sources.worktrees).toBe(false);
  expect(calls).toEqual([]);
  expect(await readdir(root)).toContain('outside');
});
it('refuses a reapable symlink pointing outside the root', async () => {
  const { root, deps, logs, calls } = await fixture();
  await mkdir(join(root, 'outside'));
  await rm(join(root, 'wt', 'merged'), { recursive: true });
  await symlink(join(root, 'outside'), join(root, 'wt', 'merged'));
  deps.readers = { listDirs: async () => ['merged'], readJobs: async () => [
    { event: 'outcome', job: 'merged', state: 'merged' },
    { event: 'finish', job: 'merged', ts: '2026-11-02T10:00:00Z' },
  ].map(row => JSON.stringify(row)).join('\n') };
  expect(await cmdFleetWtReap(['--json', '--apply'], deps)).toBe(1);
  expect(JSON.parse(logs.pop()!).removals).toEqual([{ id: 'merged', status: 'refused' }]);
  expect(calls).toEqual([]);
});
it('reports Git failures without exposing process output', async () => {
  const { deps, logs } = await fixture();
  deps.runner = async () => { throw Error('private output'); };
  expect(await cmdFleetWtReap(['--apply'], deps)).toBe(1);
  expect(logs.join('\n')).toContain('merged: failed.');
  expect(logs.join('\n')).not.toContain('private output');
});
