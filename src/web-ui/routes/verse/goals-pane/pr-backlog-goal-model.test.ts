import { describe, expect, it } from 'vitest';
import type { RepoBacklogRow } from '../fleet-merges/repo-backlog-model.js';
import { prBacklogGoal, prBacklogTotal } from './pr-backlog-goal-model.js';

const ok = (repo: string, open: number, dirty: number): RepoBacklogRow => ({ repo, state: 'ok', open, dirty, behind: 0, oldestDirtyText: '—' });
const down = (repo: string, state: 'unavailable' | 'not-enrolled'): RepoBacklogRow => ({ repo, state, open: null, dirty: null, behind: null, oldestDirtyText: '—' });

describe('prBacklogGoal', () => {
  it('is unknown with no reading, no repo, or only unreadable repos', () => {
    for (const rows of [undefined, [], [down('a/b', 'unavailable'), down('c/d', 'not-enrolled')]]) {
      expect(prBacklogGoal(rows, 5)).toEqual({ label: 'Unresolved PRs across enrolled repos → 0', value: 'unknown', tone: 'unknown' });
    }
    expect(prBacklogTotal([])).toBeNull();
  });

  it('is goal met at zero open', () => {
    expect(prBacklogGoal([ok('a/b', 0, 0), ok('c/d', 0, 0)])).toMatchObject({ value: '0 open · 0 DIRTY', tone: 'met' });
  });

  it('does not claim met when a repo could not be read', () => {
    expect(prBacklogGoal([ok('a/b', 0, 0), down('c/d', 'unavailable')])).toMatchObject({ value: '0 open · 0 DIRTY · 1 repo unread', tone: 'open' });
  });

  it('sums open and DIRTY across repos', () => {
    const goal = prBacklogGoal([ok('a/b', 4, 2), ok('c/d', 3, 1), down('e/f', 'unavailable')]);
    expect(goal).toMatchObject({ value: '7 open · 3 DIRTY · 1 repo unread', tone: 'open' });
    expect(goal.trend).toBeUndefined();
  });

  it('reports the trend against the previous total', () => {
    const rows = [ok('a/b', 4, 2), ok('c/d', 3, 1)];
    expect(prBacklogGoal(rows, 10).trend).toBe('down 3 since you opened Phantom');
    expect(prBacklogGoal(rows, 5).trend).toBe('up 2 since you opened Phantom');
    expect(prBacklogGoal(rows, 7).trend).toBe('unchanged since you opened Phantom');
    expect(prBacklogGoal(rows, 8).trend).toBe('down 1 since you opened Phantom');
  });
});
