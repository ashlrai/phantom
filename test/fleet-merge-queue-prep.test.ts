import { describe, expect, it } from 'vitest';
import { planMergeQueuePreparation, prepareMergeQueue } from '../src/core/fleet/merge-queue-prep.js';
import { planMergeBatches, type MergeBatchPr } from '../src/core/fleet/merge-batch.js';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const pr = (number: number, files: string[]): MergeBatchPr => ({ number, files, headSha: head,
  title: '', headRef: 'bridge/test', isDraft: false, mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', createdAt: null, updatedAt: null });

describe('merge queue lookahead', () => {
  it('reduces predicted conflict exposure on a star and defers its hub', () => {
    const prs = [pr(1, ['a', 'b', 'c']), pr(2, ['a']), pr(3, ['b']), pr(4, ['c'])];
    const plan = planMergeBatches({ prs });
    expect(plan.order).toEqual([2, 3, 4, 1]);
    const fifoConflicts = prs.filter((candidate, index) => prs.slice(0, index)
      .some(earlier => earlier.files.some(file => candidate.files.includes(file)))).length;
    expect(fifoConflicts).toBe(3);
    expect(plan.counts.expectedRebases).toBe(1);
    expect(planMergeQueuePreparation(prs, 4)).toEqual([
      { number: 2, headSha: head, after: [] }, { number: 3, headSha: head, after: [] },
      { number: 4, headSha: head, after: [] }, { number: 1, headSha: head, after: [2, 3, 4] },
    ]);
  });
  it('bounds work and excludes missing identities, drafts and truncated evidence', () => {
    expect(() => planMergeQueuePreparation([], 17)).toThrow();
    expect(planMergeQueuePreparation([pr(1, ['a'])], 0)).toEqual([]);
    expect(planMergeQueuePreparation([{ ...pr(1, ['a']), headSha: null },
      { ...pr(2, ['b']), isDraft: true }, pr(3, Array.from({ length: 300 }, (_, i) => `${i}`))])).toEqual([]);
  });
  it('prefetches successors but only rebases independent heads and cleans up', async () => {
    const calls: string[][] = [];
    const result = await prepareMergeQueue({ cwd: '/repo', baseSha: base,
      preparations: [{ number: 1, headSha: head, after: [] }, { number: 2, headSha: head, after: [1] }],
      git: async args => { calls.push(args); return args[0] === 'rev-parse' ? head : ''; } });
    expect(result.map(r => r.state)).toEqual(['ready', 'deferred']);
    expect(calls.filter(a => a.includes('rebase'))).toHaveLength(1);
    expect(calls.filter(a => a[0] === 'fetch')).toHaveLength(2);
    expect(calls.some(a => a[0] === 'worktree' && a[1] === 'remove')).toBe(true);
    expect(calls.some(a => a.includes('push'))).toBe(false);
  });
  it('rejects changed heads before worktree creation', async () => {
    const calls: string[][] = [];
    const result = await prepareMergeQueue({ cwd: '/repo', baseSha: base,
      preparations: [{ number: 1, headSha: head, after: [] }],
      git: async args => { calls.push(args); return base; } });
    expect(result[0]?.state).toBe('stale');
    expect(calls).toHaveLength(2);
  });
  it.each([['conflicted.ts', 'conflict'], ['', 'failed']])('classifies rebase failure %s and cleans up', async (unmerged, state) => {
    const calls: string[][] = [];
    const result = await prepareMergeQueue({ cwd: '/repo', baseSha: base,
      preparations: [{ number: 1, headSha: head, after: [] }], git: async args => {
        calls.push(args);
        if (args.includes('rebase')) throw new Error('withheld remote diagnostic');
        return args[0] === 'diff' ? unmerged : head;
      } });
    expect(result[0]?.state).toBe(state);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['worktree', 'remove']);
  });
});
