import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultHasUnpushed } from '../src/core/fleet/worktrees.js';

const root = mkdtempSync(join(tmpdir(), 'worktrees-unpushed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });

describe('defaultHasUnpushed (real git)', () => {
  it('is true for a commit no other branch holds, false once another branch has it', async () => {
    const repo = join(root, 'repo');
    git(root, 'init', '-q', repo);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(repo, 'checkout', '-q', '-b', 'job-branch');
    expect(await defaultHasUnpushed(repo)).toBe(false);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'second');
    expect(await defaultHasUnpushed(repo)).toBe(true);
    git(repo, 'branch', 'saved');
    expect(await defaultHasUnpushed(repo)).toBe(false);
  });

  it('is null when Git cannot answer', async () => {
    expect(await defaultHasUnpushed(join(root, 'not-a-repo'))).toBeNull();
  });
});
