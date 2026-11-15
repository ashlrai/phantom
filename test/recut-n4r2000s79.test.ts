import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGuardianHeadEntry, GuardianHeadError } from '../src/core/fleet/guardian-head-manifest.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

describe('recut-n4r2000s79: recovered guardian-head manifest from PR #2837', () => {
  it('derives a guardian-<sha12> entry from the observed origin/HEAD with head and first parent', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'recut-n4-guardian-')));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'recut@example.invalid']);
    git(repo, ['config', 'user.name', 'recut']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']); git(repo, ['commit', '-qm', 'first']);
    const parent = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git(repo, ['commit', '-qam', 'second']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', head]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const entry = await buildGuardianHeadEntry(repo);
    expect(entry.cohortId).toBe(`guardian-${head.slice(0, 12)}`);
    expect(entry.mergeCommit).toBe(head);
    expect(entry.candidateHead).toBe(head);
    expect(entry.baseHead).toBe(parent);
    expect(entry.baseBranch).toBe('main');
  });

  it('refuses a relative --head-of path with GuardianHeadError', async () => {
    await expect(buildGuardianHeadEntry('not/absolute')).rejects.toThrow(GuardianHeadError);
  });
});
