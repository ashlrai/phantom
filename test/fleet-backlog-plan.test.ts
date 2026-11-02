import { describe, expect, it } from 'vitest';
import { planMergeBacklog, type MergeBacklogItem } from '../src/core/fleet/merge-backlog-plan.js';

function pr(number: number, status = 'CLEAN'): MergeBacklogItem {
  return {
    repo: 'ashlrai/phantom', mergeState: { state: 'missing' },
    github: {
      number, state: 'OPEN', isDraft: false, headSha: 'a'.repeat(40),
      headRef: `fleet/${number}`, baseRef: 'main', isCrossRepository: false,
      mergeable: status === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
      mergeStateStatus: status, checks: 'green', behindBy: null,
    },
  };
}

// Queue-scale fixture: blocked work arrives before every ready PR.
const backlog = () => [
  ...Array.from({ length: 189 }, (_, i) => pr(i + 1, 'DIRTY')),
  ...Array.from({ length: 66 }, (_, i) => pr(i + 190, 'BEHIND')),
  ...Array.from({ length: 9 }, (_, i) => pr(i + 256)),
];

describe('conflict-aware merge backlog plan', () => {
  it('identifies 189 autonomous recuts and 66 base refreshes', () => {
    const plan = planMergeBacklog(backlog(), { merges: 4, recuts: 300 });
    expect(plan.counts).toEqual({ ready: 9, conflicting: 189, behind: 66, repair: 0, waiting: 0 });
    expect(plan.recuts).toHaveLength(189);
    expect(plan.refreshes).toHaveLength(66);
    expect(plan.refreshes.every(row => row.classification.work === 'drain')).toBe(true);
    expect(plan.recuts.every(row => row.classification.work === 'refix')).toBe(true);
    expect(plan.merges.map(row => row.github!.number)).toEqual([256, 257, 258, 259]);
  });

  it('drains ready merges across bounded passes even when every conflict persists', () => {
    let remaining = backlog();
    const merged: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const plan = planMergeBacklog(remaining, { merges: 3, recuts: 1 });
      expect(plan.recuts).toHaveLength(1);
      merged.push(...plan.merges.map(row => row.github!.number));
      remaining = remaining.filter(row => !merged.includes(row.github!.number));
    }
    expect(merged).toEqual([256, 257, 258, 259, 260, 261, 262, 263, 264]);
    expect(remaining).toHaveLength(255);
  });

  it('defers drafts, red checks, unknown observations and corrupt records', () => {
    const rows = [pr(1), pr(2), pr(3), pr(4), pr(5)];
    rows[0]!.github!.isDraft = true;
    rows[1]!.github!.checks = 'red';
    rows[2]!.github = null;
    rows[3]!.mergeState = { state: 'corrupt', reason: 'fixture' };
    rows[4]!.github!.mergeable = 'UNKNOWN';
    const plan = planMergeBacklog(rows, { merges: 10, recuts: 10 });
    expect(plan.merges).toEqual([]);
    expect(plan.recuts).toEqual([]);
    expect(plan.deferred).toHaveLength(5);
    expect(plan.counts.repair).toBe(1);
  });

  it('rejects duplicate identities while keeping same-number PRs in different repos', () => {
    const other = { ...pr(2), repo: 'ashlrai/verse' };
    const plan = planMergeBacklog([pr(1), { ...pr(1), repo: 'AshlrAI/Phantom' }, pr(2), other], { merges: 4, recuts: 4 });
    expect(plan.merges.map(row => row.repo)).toEqual(['ashlrai/phantom', 'ashlrai/verse']);
    expect(plan.deferred.map(row => row.classification.reason)).toEqual(['duplicate-pr-observation', 'duplicate-pr-observation']);
  });

  it('zero limits retain every item without changing the input', () => {
    const rows = backlog();
    const before = JSON.stringify(rows);
    const plan = planMergeBacklog(rows, { merges: 0, recuts: 0 });
    expect(plan.merges).toEqual([]);
    expect(plan.recuts).toEqual([]);
    expect(plan.deferred.length + plan.refreshes.length).toBe(rows.length);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid lane limit %s', limit => {
    expect(() => planMergeBacklog([], { merges: limit, recuts: 1 })).toThrow(RangeError);
    expect(() => planMergeBacklog([], { merges: 1, recuts: limit })).toThrow(RangeError);
  });
});
