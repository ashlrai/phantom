import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyEmptyLog,
  FLEET_EMPTY_WHY_LOG_LINES,
  FLEET_EMPTY_WHY_REASONS,
  readEmptyJobs,
} from '../src/core/fleet/empty-jobs.js';

describe('restored empty-jobs classifier surface (RQ-PHX-RECUTCOREFLEETC411)', () => {
  it('re-exports the shared classifier contract from empty-jobs', () => {
    expect(FLEET_EMPTY_WHY_LOG_LINES).toBe(60);
    expect([...FLEET_EMPTY_WHY_REASONS]).toEqual(['lint-env', 'interrupted', 'blocked', 'limit', 'other']);
    expect(classifyEmptyLog(null)).toBe('other');
    expect(classifyEmptyLog('worker hit usage limit; stopping')).toBe('limit');
    expect(classifyEmptyLog('npx eslint finished with findings')).toBe('lint-env');
  });

  it('classifies real job logs through readEmptyJobs on a temporary runs dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recut-corefleet-c411-'));
    const now = Date.parse('2026-11-14T12:00:00Z');
    try {
      const runs = join(root, 'runs');
      const worktrees = join(root, 'worktrees');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await mkdir(join(worktrees, 'X'), { recursive: true });
      const ledger = ['X', 'Y', 'Z'].map(job => JSON.stringify({
        event: 'outcome', empty: true, job, lane: 'devin', ts: new Date(now - 1000).toISOString(),
      })).join('\n');
      await writeFile(join(runs, 'metrics/jobs.jsonl'), ledger);
      await writeFile(join(worktrees, 'X', 'BRIDGE_NOTES.md'), 'duplicate of an earlier job');
      await writeFile(join(runs, 'X.log'), 'npx eslint src/\n2 problems found');
      await writeFile(join(runs, 'Y.log'), 'process exited code 130');
      // The lint marker sits outside the tail window: the last FLEET_EMPTY_WHY_LOG_LINES lines are benign.
      const zlog = ['eslint only on the first line', ...Array.from({ length: FLEET_EMPTY_WHY_LOG_LINES }, (_, i) => `ok ${i}`)].join('\n');
      await writeFile(join(runs, 'Z.log'), zlog);

      const report = await readEmptyJobs(24, runs, worktrees, now);
      expect(report?.jobs.find(j => j.id === 'X')).toMatchObject({ class: 'duplicate', lane: 'devin' });
      expect(report?.reasons?.by_reason).toEqual({ 'lint-env': 1, interrupted: 1, blocked: 0, limit: 0, other: 1 });
      expect(Object.keys(report?.reasons?.by_reason ?? {})).toEqual([...FLEET_EMPTY_WHY_REASONS]);
      expect(report?.reasons?.recent.map(r => r.id)).toEqual(['Z', 'Y', 'X']);
      expect(report?.reasons?.recent.find(r => r.id === 'Z')?.reason).toBe('other');
      expect(classifyEmptyLog(await readFile(join(runs, 'Z.log'), 'utf8'))).toBe('other');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
