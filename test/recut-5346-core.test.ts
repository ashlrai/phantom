import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { classifyEmptyLog, readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

it('keeps a symlinked log private while preserving notes classification and reason counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recut-5346-'));
  const now = Date.parse('2026-11-14T12:00:00Z');
  try {
    const runs = join(root, 'runs');
    const worktrees = join(root, 'worktrees');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(worktrees, 'A'), { recursive: true });
    const ledger = ['A', 'B'].map(job => JSON.stringify({
      event: 'outcome', empty: true, job, lane: 'claude', ts: new Date(now - 1000).toISOString(),
    })).join('\n');
    await writeFile(join(runs, 'metrics/jobs.jsonl'), ledger);
    await writeFile(join(worktrees, 'A', 'BRIDGE_NOTES.md'), 'duplicate of an earlier job');
    const privateLog = join(root, 'private.log');
    await writeFile(privateLog, 'eslint private diagnostic sentinel');
    await symlink(privateLog, join(runs, 'A.log'));
    await writeFile(join(runs, 'B.log'), 'process exited code 130; usage limit reached');

    const report = await readEmptyJobs(24, runs, worktrees, now);
    expect(report?.jobs[0]).toMatchObject({ id: 'A', class: 'duplicate' });
    expect(report?.reasons).toEqual({
      by_reason: { 'lint-env': 0, interrupted: 1, blocked: 0, limit: 0, other: 1 },
      recent: [
        { id: 'B', lane: 'claude', reason: classifyEmptyLog('process exited code 130; usage limit reached') },
        { id: 'A', lane: 'claude', reason: 'other' },
      ],
    });
    expect(JSON.stringify(report)).not.toContain('private diagnostic sentinel');
    expect(await readFile(join(runs, 'metrics/jobs.jsonl'), 'utf8')).toBe(ledger);
    expect(await readFile(privateLog, 'utf8')).toBe('eslint private diagnostic sentinel');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
