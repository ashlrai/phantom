import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveMaintRoots } from '../src/core/disk-maint/protect.js';
import { readWorktreeBridgeCommits } from '../src/core/disk-maint/worktree-evidence.js';

it('reads exact bridge subjects from origin/master and invalidates the index when it moves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'phm-disk-maint-bridge-'));
  const roots = resolveMaintRoots({ home });
  const repo = join(dirname(roots.wtDir), 'phantom');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  vi.stubEnv('ASHLR_LANDED_REPO', repo);
  try {
    mkdirSync(roots.runsDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    git('init', '-q');
    const job = 'RQ-DEVINCLOUD-RQ-DVL-BUS-1795413651-N17';
    const commit = (subject: string) => git('-c', 'user.email=fixture@example.test', '-c', 'user.name=fixture',
      'commit', '-q', '--allow-empty', '-m', subject);
    commit(`bridge(${job}): (#9147)`);
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    expect((await readWorktreeBridgeCommits(roots)).get(job)).toMatchObject({
      at: expect.any(Number), prUrl: 'https://github.com/ashlrai/phantom/pull/9147', mergeSha: git('rev-parse', 'HEAD'),
    });
    commit('bridge(RQ-VAULT-PHM-1): (#9148)');
    expect((await readWorktreeBridgeCommits(roots)).has('RQ-VAULT-PHM-1')).toBe(false);
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    expect((await readWorktreeBridgeCommits(roots)).has('RQ-VAULT-PHM-1')).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
