import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readWorktrees, type WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditFs } from '../src/core/fleet/wt-audit.js';

it('diagnoses an old reaping marker without authorizing its worktree removal in apply mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reaper-preservation-'));
  try {
    const wtRoot = join(root, 'wt');
    const runsRoot = join(root, 'runs');
    const now = Date.parse('2026-11-17T12:00:00Z');
    const fs: WtAuditFs = {
      dirs: async path => path === wtRoot ? ['RQ-FAKE'] : [],
      entries: async path => path === runsRoot ? ['queue', 'metrics'] : path === join(runsRoot, 'queue') ? ['status.json', 'keep.txt', 'run'] : path === join(runsRoot, 'queue', 'run') ? ['RQ-FAKE.reaping'] : null,
      text: async path => path === join(runsRoot, 'queue', 'status.json') ? '{}' : path === join(runsRoot, 'queue', 'keep.txt') ? '' : null,
      mtime: async path => path === join(wtRoot, 'RQ-FAKE') ? now - 10 * 3_600_000 : null,
      real: async path => path,
    };
    const remove = vi.fn(async () => undefined);
    const logRemoval = vi.fn(async () => undefined);
    const deps: WorktreesDeps = {
      now, wtRoot, runsRoot, fs,
      readJobs: async () => ({ state: 'healthy', text: [
        { event: 'launch', job: 'RQ-FAKE', ts: new Date(now - 11 * 3_600_000).toISOString() },
        { event: 'outcome', job: 'RQ-FAKE', state: 'MERGED', ts: new Date(now - 10 * 3_600_000).toISOString() },
      ].map(JSON.stringify).join('\n') }),
      ps: () => '', readPins: () => ({ paths: [], valid: true }),
      isClean: async () => true, measure: () => ({ bytes: 1, complete: true }),
      readReapLog: async () => ({ state: 'missing', text: '' }), remove, logRemoval,
    };
    const report = await readWorktrees('apply', deps);
    expect(report.reaper).toMatchObject({ state: 'stale', reason: 'stuck-run', stuckRuns: ['RQ-FAKE'], eligible: [] });
    expect(report.rows[0]).toMatchObject({ job: 'RQ-FAKE', safe: false });
    expect(report.removals).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
    expect(logRemoval).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
