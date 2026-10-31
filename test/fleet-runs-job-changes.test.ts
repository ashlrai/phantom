import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(base = 'a60908e') {
  const homeDir = await mkdtemp(join(tmpdir(), 'job-changes-')); roots.push(homeDir);
  const runsDir = join(homeDir, 'runs'); const repo = join(homeDir, 'repo');
  await mkdir(runsDir); await mkdir(repo);
  await writeFile(join(runsDir, 'RQ-TEST.base'), `${base} branch ${repo}\n`);
  return { homeDir, runsDir, repo };
}
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
it('reads real tracked and untracked changes without exposing the worktree', async () => {
  const opts = await setup();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: opts.repo, encoding: 'utf8' });
  git('init', '-q'); await writeFile(join(opts.repo, 'file.txt'), 'old\n'); git('add', 'file.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD').trim(); await writeFile(join(opts.runsDir, 'RQ-TEST.base'), `${sha} branch ${opts.repo}\n`);
  await writeFile(join(opts.repo, 'file.txt'), 'new\nmore\n'); await writeFile(join(opts.repo, 'new.txt'), 'new\n');
  const pending = getFleetJobChanges('RQ-TEST', opts);
  expect(getFleetJobChanges('RQ-TEST', opts)).toBe(pending);
  const result = await pending;
  expect(result.state).toBe('live'); expect(result.totals).toEqual({ files: 2, added: 2, removed: 1 });
  expect(result.files).toContainEqual({ path: 'new.txt', added: null, removed: null, status: 'untracked' });
  expect(JSON.stringify(result)).not.toContain(opts.homeDir);
});
it('uses HEAD for an invalid sha, bounds files, and parses renames and binary counts', async () => {
  const opts = await setup('--bad');
  const runner = vi.fn<GitRunner>(async (_bin, args) => ok(args[0] === 'diff' ? '4\t2\tfile.ts\0-\t-\tbinary\0' : Array.from({ length: 205 }, (_, i) => `? new${i}\0`).join('')));
  const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
  expect(runner.mock.calls[0]?.[1]).toEqual(['diff', '--numstat', '-z', 'HEAD']);
  expect(runner.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 5000, maxStdoutBytes: 1048576 });
  expect(result.files).toHaveLength(200); expect(result.truncated).toBe(true);
  expect(result.files[1]?.added).toBeNull(); expect(result.baseSha).toBeNull();
});
it('rejects symlinked base files, worktrees and paths outside home', async () => {
  const opts = await setup(); const runner = vi.fn<GitRunner>();
  const linked = join(opts.homeDir, 'linked'); await symlink(opts.repo, linked);
  for (const path of [linked, `${linked}/`, tmpdir()]) {
    await writeFile(join(opts.runsDir, 'RQ-TEST.base'), `a60908e branch ${path}\n`);
    expect((await getFleetJobChanges('RQ-TEST', { ...opts, runner })).state).toBe('missing');
  }
  await rm(join(opts.runsDir, 'RQ-TEST.base')); await symlink(join(opts.homeDir, 'anything'), join(opts.runsDir, 'RQ-TEST.base'));
  expect((await getFleetJobChanges('RQ-TEST', { ...opts, runner })).state).toBe('missing'); expect(runner).not.toHaveBeenCalled();
});

it('degrades on git failures and filters unsafe paths', async () => {
  const opts = await setup();
  const runner: GitRunner = async (_bin, args) => args[0] === 'diff' ? ok('1\t0\t/absolute\0' + '2\t1\t\0old\0renamed\0') : { ...ok(''), code: 1 };
  const result = await getFleetJobChanges('RQ-TEST', { ...opts, runner });
  expect(result.state).toBe('degraded');
  expect(result.files).toEqual([{ path: 'renamed', added: 2, removed: 1, status: 'renamed' }]);
  expect(JSON.stringify(result)).not.toContain(opts.homeDir);
});
