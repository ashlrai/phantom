import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(spaced: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'job-path-'));
  roots.push(root);
  const homeDir = join(root, spaced ? 'home with spaces' : 'home');
  const runsDir = join(homeDir, 'runs');
  const repo = join(homeDir, spaced ? 'project with spaces ' : 'project');
  await mkdir(runsDir, { recursive: true });
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: homeDir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git('init', '-q');
  await writeFile(join(repo, 'staged.txt'), 'old staged\n');
  await writeFile(join(repo, 'unstaged.txt'), 'old unstaged\n');
  git('add', 'staged.txt', 'unstaged.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'staged.txt'), 'new staged\nsecond line\n');
  git('add', 'staged.txt');
  await writeFile(join(repo, 'unstaged.txt'), 'new unstaged\n');
  await writeFile(join(repo, 'untracked.txt'), 'new\n');
  return { root, homeDir, runsDir, repo, sha, baseFile: join(runsDir, 'RQ-TEST.base') };
}

describe('worker changes with worktree paths containing spaces', () => {
  it.each([true, false])('reads staged and unstaged changes (spaced path: %s)', async spaced => {
    const f = await fixture(spaced);
    await writeFile(f.baseFile, `${f.sha} branch/name ${f.repo}\n`);
    const result = await getFleetJobChanges('RQ-TEST', f);
    expect(result).toMatchObject({ state: 'live', baseSha: f.sha, truncated: false,
      totals: { files: 3, added: 3, removed: 2 } });
    expect(result.files).toHaveLength(3);
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'staged.txt', added: 2, removed: 1, status: 'modified' },
      { path: 'unstaged.txt', added: 1, removed: 1, status: 'modified' },
      { path: 'untracked.txt', added: null, removed: null, status: 'untracked' },
    ]));
    expect(JSON.stringify(result)).not.toContain(f.homeDir);
    expect(JSON.stringify(result)).not.toContain(f.repo);
  });

  it('refuses malformed headers and paths outside home without invoking Git', async () => {
    const f = await fixture(true);
    const runner = vi.fn<GitRunner>();
    for (const header of ['', f.sha, `${f.sha} branch`, `${f.sha} branch relative/path`, `${f.sha} branch ${f.root}`]) {
      await writeFile(f.baseFile, `${header}\n`);
      const result = await getFleetJobChanges('RQ-TEST', { ...f, runner });
      expect(result).toMatchObject({ state: 'missing', baseSha: null, files: [], totals: { files: 0, added: 0, removed: 0 } });
      expect(JSON.stringify(result)).not.toContain(f.homeDir);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses symlinked base files, worktrees and escaping ancestors', async () => {
    const f = await fixture(true);
    const runner = vi.fn<GitRunner>();
    const linkedRepo = join(f.homeDir, 'linked repo');
    const linkedAncestor = join(f.homeDir, 'linked ancestor');
    const outside = join(f.root, 'outside');
    await mkdir(join(outside, 'project'), { recursive: true });
    await symlink(f.repo, linkedRepo);
    await symlink(outside, linkedAncestor);
    for (const path of [linkedRepo, `${linkedRepo}/`, join(linkedAncestor, 'project')]) {
      await writeFile(f.baseFile, `${f.sha} branch ${path}\n`);
      const result = await getFleetJobChanges('RQ-TEST', { ...f, runner });
      expect(result.state).toBe('missing');
      expect(JSON.stringify(result)).not.toContain(f.homeDir);
    }
    const realBase = join(f.root, 'real.base');
    await writeFile(realBase, `${f.sha} branch ${f.repo}\n`);
    await rm(f.baseFile);
    await symlink(realBase, f.baseFile);
    expect((await getFleetJobChanges('RQ-TEST', { ...f, runner })).state).toBe('missing');
    expect(runner).not.toHaveBeenCalled();
  });
});
