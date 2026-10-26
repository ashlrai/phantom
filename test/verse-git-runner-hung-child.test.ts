/**
 * The Verse git/gh runner's timeout must settle even when the killed git
 * leaves a grandchild (a pre-commit hook's background job, ssh, a credential
 * helper) holding the stdout/stderr pipe. Waiting on 'close' alone parks the
 * agent loop's commit/push/`gh pr view` forever: signalling only git leaves
 * the pipe open, so 'close' never fires.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner } from '../src/core/verse/git-ops.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repoWithHungHook(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verse-git-hung-'));
  dirs.push(dir);
  const git = (...args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  // The hook forks a SIGTERM-immune grandchild that inherits git's pipes, then
  // blocks itself. The marker argument lets the test find and reap stragglers.
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\n(trap '' TERM; exec sleep 25 ${marker}) &\nexec sleep 25 ${marker}\n`);
  chmodSync(hook, 0o755);
  return dir;
}

function survivors(marker: string): number {
  try { return execFileSync('pgrep', ['-f', `sleep 25 ${marker}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; }
}

describe.skipIf(process.platform === 'win32')('defaultGitRunner timeout with a pipe-holding grandchild', () => {
  it('settles as timedOut and reaps the whole process group', async () => {
    const marker = `${process.pid}${Date.now()}`.slice(-9);
    const dir = repoWithHungHook(marker);
    const started = Date.now();
    const result = await Promise.race([
      defaultGitRunner('git', ['commit', '-q', '-m', 'x'], { cwd: dir, timeoutMs: 300 }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 8_000).unref()),
    ]);
    try {
      expect(result).not.toBe('hung');
      expect(result).toMatchObject({ code: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(survivors(marker)).toBe(0);
    } finally {
      try { execFileSync('pkill', ['-KILL', '-f', `sleep 25 ${marker}`]); } catch { /* none left */ }
    }
  }, 15_000);
});
