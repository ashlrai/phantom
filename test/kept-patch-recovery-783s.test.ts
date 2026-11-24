import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readKeptLanded } from '../src/core/fleet/kept-landed.js';

it('checks recut patches, post-images, novel and partial diffs, and broken worktrees without writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kept-'));
  const repo = join(home, 'repo'), wtRoot = join(home, 'wt'), runsRoot = join(home, 'runs');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    for (const dir of [repo, wtRoot, runsRoot]) mkdirSync(dir);
    git(repo, 'init', '-b', 'master');
    git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test');
    writeFileSync(join(repo, 'alpha'), 'one\nmiddle\nlast\n'); writeFileSync(join(repo, 'beta'), 'plain\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    for (const job of ['patch', 'content', 'novel', 'part', 'fallback', 'untracked', 'badbase']) {
      git(repo, 'worktree', 'add', '--detach', join(wtRoot, job), base);
      if (job !== 'fallback') writeFileSync(join(runsRoot, `${job}.base`), `${base} work\n`);
    }
    writeFileSync(join(wtRoot, 'untracked', 'new-file'), 'untracked work');
    writeFileSync(join(runsRoot, 'badbase.base'), 'invalid base');
    writeFileSync(join(wtRoot, 'patch', 'alpha'), 'two\nmiddle\nlast\n');
    writeFileSync(join(wtRoot, 'content', 'alpha'), 'two\nmiddle\nnext\n');
    writeFileSync(join(wtRoot, 'novel', 'alpha'), 'fresh\n');
    writeFileSync(join(wtRoot, 'fallback', 'alpha'), 'fresh\n');
    writeFileSync(join(wtRoot, 'part', 'alpha'), 'two\nmiddle\nnext\n');
    writeFileSync(join(wtRoot, 'part', 'beta'), 'fresh\n');
    writeFileSync(join(repo, 'alpha'), 'two\nmiddle\nlast\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'recut');
    writeFileSync(join(repo, 'alpha'), 'two\nmiddle\nnext\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later');
    git(repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    mkdirSync(join(wtRoot, 'broken')); writeFileSync(join(wtRoot, 'broken', '.git'), 'gitdir: missing\n');
    mkdirSync(join(wtRoot, 'plain'));
    const before = git(repo, 'status', '--porcelain');
    const refsBefore = git(repo, 'show-ref');
    const indexesBefore = Object.fromEntries(['patch', 'content', 'novel', 'part', 'fallback', 'untracked', 'badbase'].map(job => [job, git(join(wtRoot, job), 'status', '--porcelain=v1')]));
    const now = Date.now(), old = new Date(now - 100 * 3_600_000);
    for (const job of ['patch', 'content', 'novel', 'part', 'fallback', 'untracked', 'badbase', 'broken']) utimesSync(join(wtRoot, job), old, old);
    writeFileSync(join(runsRoot, 'novel.log'), 'plain\n');
    const report = await readKeptLanded({ wtRoot, runsRoot, now });
    expect(Object.fromEntries(report.worktrees.map(row => [row.job, row.landed]))).toEqual({
      patch: 'yes', content: 'yes', novel: 'no', part: 'partial', fallback: 'no', untracked: 'unknown', badbase: 'unknown', broken: 'unknown',
    });
    expect(report.worktrees[0]?.job).toBe('novel');
    expect(report.worktrees.find(row => row.job === 'patch')).toMatchObject({ filesChanged: 1, linesChanged: 2, base });
    expect(report.worktrees.find(row => row.job === 'patch')?.evidence).toBe('patch-id');
    expect(report.worktrees.find(row => row.job === 'content')?.evidence).toBe('post-image');
    expect(report.limitation).toMatch(/untracked content is not assessed/);
    const exhausted = await readKeptLanded({ wtRoot, runsRoot, scanBudgetMs: 0 });
    expect(exhausted.worktrees).toHaveLength(0);
    expect(exhausted.skipped).toBeGreaterThan(0);
    const filtered = await readKeptLanded({ wtRoot, runsRoot, now, olderThanHours: 72 });
    expect(filtered.skipped).toBe(1); expect(filtered.worktrees).toHaveLength(7);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    expect(git(repo, 'show-ref')).toBe(refsBefore);
    for (const [job, status] of Object.entries(indexesBefore)) expect(git(join(wtRoot, job), 'status', '--porcelain=v1')).toBe(status);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
