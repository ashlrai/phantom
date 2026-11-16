import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReleaseStatus, getReleaseStatus } from '../src/core/release/status.js';

describe('release status', () => {
  it('reads local tags and default branch commits and reports missing evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-status-'));
    const path = join(root, 'phantom');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', path]);
      git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
      git('commit', '--allow-empty', '-qm', 'first'); git('tag', 'v1.0');
      git('commit', '--allow-empty', '-qm', 'second');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      const report = await getReleaseStatus({ root, repos: ['phantom', 'locus'] });
      expect(report.repos[0]).toMatchObject({ defaultBranch: 'main', latestTag: 'v1.0', ageDays: 0, unreleasedCommits: 1 });
      expect(report.repos[1]).toMatchObject({ latestTag: null, ageDays: null, unreleasedCommits: null });
      expect(formatReleaseStatus(report).split('\n')).toEqual([
        'ashlrai/phantom: latest tag v1.0, age 0 days, commits since tag 1.',
        'ashlrai/locus: latest tag unknown, age unknown, commits since tag unknown.',
      ]);
      git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
      expect((await getReleaseStatus({ root, repos: ['phantom'] })).repos[0]?.unreleasedCommits).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
