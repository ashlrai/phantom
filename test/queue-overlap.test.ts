import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueOverlap } from '../src/cli/fleet-queue-overlap.js';
import { queueOverlap } from '../src/core/queue/overlap.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(refs = true) {
  const cwd = mkdtempSync(join(tmpdir(), 'queue-overlap-')); dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path: string, text: string) => writeFileSync(join(cwd, path), text);
  for (const dir of ['src', 'fleet', 'queue']) mkdirSync(join(cwd, dir));
  git('init', '-q'); git('remote', 'add', 'origin', 'https://github.com/ashlrai/phantom.git');
  git('config', 'remote.origin.pushurl', 'disabled://fixture');
  put('src/a.ts', 'export const a = 1;');
  git('add', 'src/a.ts');
  const tree = git('write-tree');
  const commit = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'Fixture');
  if (refs) { git('update-ref', 'refs/remotes/origin/trunk', commit); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'); }
  put('prompt.md', 'Edit src/z.ts and src/a.ts and src/a.ts.\nNever touch src/ignored.ts');
  put('fleet/open-prs.json', JSON.stringify({ repo: 'ashlrai/phantom', items: [{ number: 7, files: ['src/a.ts'] }, { number: 9, files: ['src/else.ts'] }] }));
  put('queue/router-queue.md', '- READY RQ-B (repo=phantom): src/z.ts src/a.ts\n- RUNNING RQ-C (repo=ashlrai/phantom): src/a.ts\n- READY RQ-X (repo=locus): src/a.ts\n- DONE RQ-D (repo=phantom): src/a.ts\n- READY prompt (repo=phantom): src/a.ts\n');
  return { cwd, runsDir: cwd, git, put, commit };
}
it('reports sorted exact overlaps, ignores other repos, inactive rows and self; writes nothing', async () => {
  const f = fixture(), before = readFileSync(join(f.cwd, 'queue/router-queue.md'), 'utf8');
  const report = await queueOverlap('prompt.md', f);
  expect(report).toMatchObject({ schema: 'queue.overlap.v1', paths: ['src/a.ts', 'src/z.ts'], defaultRef: 'refs/remotes/origin/trunk', defaultCommit: f.commit,
    defaultBranchPaths: ['src/a.ts'], openPrs: [{ number: 7, paths: ['src/a.ts'] }], queued: [{ id: 'RQ-B', paths: ['src/a.ts', 'src/z.ts'] }, { id: 'RQ-C', paths: ['src/a.ts'] }] });
  expect(await queueOverlap('prompt.md', f)).toEqual(report);
  expect(readFileSync(join(f.cwd, 'queue/router-queue.md'), 'utf8')).toBe(before);
  vi.stubEnv('ASHLR_RUNS_DIR', f.cwd);
  vi.spyOn(process, 'cwd').mockReturnValue(f.cwd);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetQueueOverlap(['--json', join(f.cwd, 'prompt.md')])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'queue.overlap.v1', paths: report.paths, queued: report.queued });
  expect(await cmdFleetQueueOverlap([ join(f.cwd, 'prompt.md')])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('Open PRs: #7: src/a.ts');
});
it('keeps default-branch paths repository-relative from a subdirectory cwd', async () => {
  const f = fixture();
  const root = await queueOverlap('prompt.md', f);
  writeFileSync(join(f.cwd, 'src/prompt.md'), 'Edit src/a.ts');
  const nested = await queueOverlap('prompt.md', { ...f, cwd: join(f.cwd, 'src') });
  expect(nested.defaultCommit).toBe(root.defaultCommit);
  expect(nested.defaultBranchPaths).toEqual(['src/a.ts']);
});
it('reports no overlap separately from missing refs and sources', async () => {
  const f = fixture(); f.put('prompt.md', 'Edit src/unrelated.ts');
  expect(await queueOverlap('prompt.md', f)).toMatchObject({ defaultBranchPaths: [], openPrs: [], queued: [] });
  const missing = fixture(false); rmSync(join(missing.cwd, 'fleet/open-prs.json')); rmSync(join(missing.cwd, 'queue/router-queue.md'));
  const result = await queueOverlap('prompt.md', missing);
  expect(result).toMatchObject({ defaultRef: null, defaultCommit: null, defaultBranchPaths: null, openPrs: null, queued: null });
  expect(result.gaps).toHaveLength(4);
});
it('keeps missing PR refs, wrong-repo snapshots and unsupported prompts explicit', async () => {
  const f = fixture(); f.put('fleet/open-prs.json', '{"repo":"ashlrai/phantom","items":[{"number":7}]}');
  expect((await queueOverlap('prompt.md', f)).gaps).toContain('PR #7: file list is incomplete and local refs are unavailable.');
  f.put('src/a.ts', 'export const a = 2;'); f.git('add', 'src/a.ts');
  const head = f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', f.git('write-tree'), '-p', f.commit, '-m', 'PR fixture');
  f.git('update-ref', 'refs/pull/7/head', head);
  expect((await queueOverlap('prompt.md', f)).openPrs).toEqual([{ number: 7, paths: ['src/a.ts'] }]);
  f.put('fleet/open-prs.json', '{"repo":"ashlrai/locus","items":[]}'); f.put('prompt.md', 'Improve the queue');
  expect(await queueOverlap('prompt.md', f)).toMatchObject({ paths: [], openPrs: null });
  f.put('fleet/open-prs.json', 'broken json');
  expect((await queueOverlap('prompt.md', f)).gaps).toContain('Open PR snapshot is unreadable.');
});
it('validates usage and emits a stable JSON error without echoing input', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const args of [[], ['a', 'b'], ['--apply'], ['a', '--json', '--json']]) expect(await cmdFleetQueueOverlap([ ...args])).toBe(2);
  expect(await cmdFleetQueueOverlap([ '--help'])).toBe(0);
  expect(await cmdFleetQueueOverlap([ '/missing/prompt', '--json'])).toBe(1);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ schema: 'queue.overlap.v1', error: 'Cannot read prompt; use a regular file of at most 4 MiB.' });
});
