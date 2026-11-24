import { describe, expect, it, vi } from 'vitest';
import { formatWorktrees, readWorktrees, type WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditFs } from '../src/core/fleet/wt-audit.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const log = (...entries: [number, string][]) => entries.map(([hours, status]) => JSON.stringify({ at: at(hours), status })).join('\n') + '\n';
function fixture(state: 'ok' | 'missing' | 'unreadable', text = '', marker = false, eligible = true) {
  const fs: WtAuditFs = {
    dirs: async path => path === '/wt' ? ['RQ-FAKE'] : [],
    entries: async path => path === '/runs' ? ['queue', 'metrics'] : path === '/runs/queue' ? ['status.json', 'keep.txt', 'run'] : path === '/runs/queue/run' ? (marker ? ['RQ-FAKE.reaping'] : []) : null,
    text: async path => path === '/runs/queue/status.json' ? '{}' : path === '/runs/queue/keep.txt' ? '' : null,
    mtime: async path => path === '/wt/RQ-FAKE' ? now - 10 * 3_600_000 : null,
    real: async path => path,
  };
  return { now, wtRoot: '/wt', runsRoot: '/runs', fs,
    readJobs: async () => ({ state: 'healthy' as const, text: [ { event: 'launch', job: 'RQ-FAKE', ts: at(11) }, { event: 'outcome', job: 'RQ-FAKE', state: eligible ? 'MERGED' : 'OPEN', ts: at(10) } ].map(JSON.stringify).join('\n') }),
    ps: () => '', readPins: () => ({ paths: [], valid: true }), isClean: async () => true,
    measure: () => ({ bytes: 1, complete: true }), readReapLog: async () => ({ state, text }),
    remove: vi.fn(async () => undefined), logRemoval: vi.fn(async () => undefined),
  } satisfies WorktreesDeps;
}

describe('reaper diagnosis through worktrees', () => {
  it('reports recent batch and ignores malformed, partial and future records', async () => {
    const report = await readWorktrees('list', fixture('ok', log([1, 'removed'], [1, 'refused'], [-1, 'failed']) + 'bad\n{"at":'));
    expect(report.reaper).toMatchObject({ reason: 'ran-recently', eligible: ['RQ-FAKE'], lastRun: { removed: 1, refused: 1, failed: 0 } });
    expect(formatWorktrees(report).join('\n')).toContain('Reaper: healthy');
  });
  it('distinguishes old, missing, failed and unreadable evidence', async () => {
    for (const [state, text, reason] of [ ['ok', log([30, 'removed']), 'last-run-old'], ['missing', '', 'never-ran'], ['ok', log([1, 'failed']), 'last-run-failed'], ['unreadable', '', 'log-unreadable'] ] as const) {
      const report = await readWorktrees('list', fixture(state, text));
      expect(report.reaper?.reason).toBe(reason);
      expect(formatWorktrees(report).join('\n')).not.toContain('never ran');
    }
  });
  it('reports no eligible work and diagnoses stuck markers without removing them', async () => {
    expect((await readWorktrees('list', fixture('missing', '', false, false))).reaper?.reason).toBe('nothing-to-reap');
    const report = await readWorktrees('list', fixture('ok', log([1, 'removed']), true));
    expect(report.reaper).toMatchObject({ reason: 'stuck-run', stuckRuns: ['RQ-FAKE'], eligible: [] });
  });
  it('never invokes removal or logging for list and dry-run', async () => {
    for (const mode of ['list', 'dry-run'] as const) {
      const deps = fixture('missing');
      await readWorktrees(mode, deps);
      expect(deps.remove).not.toHaveBeenCalled();
      expect(deps.logRemoval).not.toHaveBeenCalled();
    }
  });
});
