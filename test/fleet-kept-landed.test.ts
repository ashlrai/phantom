import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readKeptLanded } from '../src/core/fleet/kept-landed.js';
import { cmdFleetKept } from '../src/cli/kept-landed.js';

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
    for (const job of ['patch', 'content', 'novel', 'part', 'fallback']) {
      git(repo, 'worktree', 'add', '--detach', join(wtRoot, job), base);
      if (job !== 'fallback') writeFileSync(join(runsRoot, `${job}.base`), `${base} work\n`);
    }
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
    const now = Date.now(), old = new Date(now - 100 * 3_600_000);
    for (const job of ['patch', 'content', 'novel', 'part', 'fallback', 'broken']) utimesSync(join(wtRoot, job), old, old);
    writeFileSync(join(runsRoot, 'novel.log'), 'plain\n');
    const report = await readKeptLanded({ wtRoot, runsRoot, now });
    expect(Object.fromEntries(report.worktrees.map(row => [row.job, row.landed]))).toEqual({
      patch: 'yes', content: 'yes', novel: 'no', part: 'partial', fallback: 'no', broken: 'unknown',
    });
    expect(report.worktrees[0]?.job).toBe('novel');
    expect(report.worktrees.find(row => row.job === 'patch')).toMatchObject({ filesChanged: 1, linesChanged: 2, base });
    expect(JSON.parse(JSON.stringify(report)).summary).toMatch(/6 kept worktrees.*2 already landed, 1 partly, 2 not landed, 1 unknown; 0 skipped/);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdFleetKept(['--json'], async () => report)).toBe(0);
      expect(JSON.parse(out.mock.calls[0]![0])).toEqual(report);
      expect(await cmdFleetKept([], async () => report)).toBe(0);
      expect(out.mock.calls[1]![0]).toBe(report.summary);
    } finally { out.mockRestore(); }
    const filtered = await readKeptLanded({ wtRoot, runsRoot, now, olderThanHours: 72 });
    expect(filtered.skipped).toBe(1); expect(filtered.worktrees).toHaveLength(5);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
