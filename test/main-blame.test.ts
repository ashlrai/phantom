import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdMain } from '../src/cli/main-blame.js';
import { MainBlameError, mainBlame, parseMergeMessage } from '../src/core/main-blame.js';

// Each test builds a real git fixture and probes worktrees, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** Fixture: a base commit plus six squash-style merges; merge 4 writes "broken" into state.txt. */
function fixture(): { repo: string; base: string; merges: string[] } {
  const repo = mkdtempSync(join(tmpdir(), 'main-blame-fixture-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'state.txt'), 'ok\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const merges: string[] = [];
  for (let n = 1; n <= 6; n++) {
    writeFileSync(join(repo, `m${n}.txt`), `${n}\n`);
    if (n >= 4) writeFileSync(join(repo, 'state.txt'), 'broken\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `bridge(RQ-JOB${n}): change ${n} (#${100 + n})`);
    merges.push(git(repo, 'rev-parse', 'HEAD'));
  }
  return { repo, base, merges };
}

describe('mainBlame', () => {
  it('finds merge 4 of 6 in at most 3 check runs, read-only', () => {
    const { repo, base, merges } = fixture();
    const before = git(repo, 'rev-parse', 'HEAD');
    const report = mainBlame({ repo, good: base, bad: 'HEAD', check: 'grep -qx ok state.txt' });
    expect(report).toEqual({ first_bad_sha: merges[3], pr_number: 104, pr_title: 'change 4', author_job_id: 'RQ-JOB4', checks_run: expect.any(Number) });
    expect(report.checks_run).toBeLessThanOrEqual(3);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('finds every position with at most ceil(log2 n) runs', () => {
    const { repo, base, merges } = fixture();
    for (let k = 0; k < 6; k++) {
      const report = mainBlame({ repo, good: base, bad: merges[5]!, check: 'x' }, {
        runCheck: (cwd) => !existsSync(join(cwd, `m${k + 1}.txt`)),
      });
      expect(report.first_bad_sha).toBe(merges[k]);
      expect(report.checks_run).toBeLessThanOrEqual(3);
    }
  });

  it('answers without a check run when only one merge is in range', () => {
    const { repo, merges } = fixture();
    const report = mainBlame({ repo, good: merges[2]!, bad: merges[3]!, check: 'false' });
    expect(report.first_bad_sha).toBe(merges[3]);
    expect(report.checks_run).toBe(0);
  });

  it('rejects unknown commits, reversed ranges and empty ranges', () => {
    const { repo, base, merges } = fixture();
    expect(() => mainBlame({ repo, good: 'nope', bad: 'HEAD', check: 'true' })).toThrow(MainBlameError);
    expect(() => mainBlame({ repo, good: merges[5]!, bad: base, check: 'true' })).toThrow(/ancestor/);
    expect(() => mainBlame({ repo, good: base, bad: base, check: 'true' })).toThrow(/same commit/);
  });
});

describe('parseMergeMessage', () => {
  it('reads squash and merge-commit messages', () => {
    expect(parseMergeMessage('bridge(RQ-A): Do thing (#12)', '')).toEqual({ pr_number: 12, pr_title: 'Do thing', author_job_id: 'RQ-A' });
    expect(parseMergeMessage('Merge pull request #7 from o/branch', '\nFix it\n')).toEqual({ pr_number: 7, pr_title: 'Fix it', author_job_id: null });
    expect(parseMergeMessage('plain commit', '')).toEqual({ pr_number: null, pr_title: 'plain commit', author_job_id: null });
  });
});

describe('phm main blame', () => {
  it('prints the typed JSON report', async () => {
    const { repo, base, merges } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdMain(['blame', '--repo', repo, '--good', base, '--check', 'grep -qx ok state.txt', '--json']);
    expect(code).toBe(0);
    const out = JSON.parse(String(log.mock.calls[0]![0]));
    expect(out).toMatchObject({ first_bad_sha: merges[3], pr_number: 104, pr_title: 'change 4', author_job_id: 'RQ-JOB4' });
    expect(out.checks_run).toBeLessThanOrEqual(3);
  });

  it('exits 2 with usage on bad input', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMain(['blame', '--check', 'true'])).toBe(2);
    expect(await cmdMain(['blame', '--good', 'a', '--check', 'true', '--timeout-ms', '0'])).toBe(2);
    expect(await cmdMain(['revert'])).toBe(2);
    expect(await cmdMain(['blame', '--help'])).toBe(0);
    expect(err).toHaveBeenCalled();
  });
});
