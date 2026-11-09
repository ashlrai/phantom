import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneWorktrees, cmdWorktreesPrune } from '../src/cli/worktrees-prune.js';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); rmSync(join(homedir(), '.ashlr', 'kept-worktrees.json'), { force: true }); });

describe('worktrees prune', () => {
  it('previews and removes only old, clean, unkept terminal jobs', async () => {
    const base = mkdtempSync(join(tmpdir(), 'prune-')); roots.push(base);
    const repo = join(base, 'repo'); const root = join(base, 'wt'); const runsRoot = join(base, 'runs');
    mkdirSync(repo); mkdirSync(root); mkdirSync(join(runsRoot, 'metrics'), { recursive: true });
    git(repo, 'init'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'tracked'), 'test'); git(repo, 'add', 'tracked'); git(repo, 'commit', '-m', 'fixture');
    const names = ['merged', 'closed', 'empty', 'dirty', 'kept', 'young'];
    for (const name of names) git(repo, 'worktree', 'add', '--detach', join(root, `RQ-${name}`));
    writeFileSync(join(root, 'RQ-dirty', 'untracked'), 'keep');
    mkdirSync(join(homedir(), '.ashlr'), { recursive: true });
    writeFileSync(join(homedir(), '.ashlr', 'kept-worktrees.json'), JSON.stringify([join(root, 'RQ-kept')]));
    const now = Date.now();
    const lines = names.flatMap(name => [
      { job: `RQ-${name}`, event: 'finish', ts: new Date(now - (name === 'young' ? 3_600_000 : 3 * 3_600_000)).toISOString(), empty: name === 'empty' },
      ...(name === 'empty' ? [] : [{ job: `RQ-${name}`, event: 'outcome', state: name === 'closed' ? 'CLOSED' : 'MERGED' }]),
    ]);
    writeFileSync(join(runsRoot, 'metrics', 'jobs.jsonl'), lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    const preview = await pruneWorktrees(false, { root, runsRoot, now });
    expect(preview.dryRun).toBe(true);
    expect(preview.worktrees.map(w => w.reason).sort()).toEqual(['closed', 'empty', 'merged']);
    expect(preview.worktrees.every(w => w.sizeBytes > 0)).toBe(true);
    expect(existsSync(join(root, 'RQ-merged'))).toBe(true);
    const result = await pruneWorktrees(true, { root, runsRoot, now });
    expect(result.errors).toBe(0);
    expect(result.worktrees.every(w => w.status === 'removed')).toBe(true);
    for (const name of ['dirty', 'kept', 'young']) expect(existsSync(join(root, `RQ-${name}`))).toBe(true);
    for (const name of ['merged', 'closed', 'empty']) expect(existsSync(join(root, `RQ-${name}`))).toBe(false);
  });
  it('rejects conflicting modes', async () => {
    expect(await cmdWorktreesPrune(['--dry-run', '--apply'])).toBe(2);
  });
});
