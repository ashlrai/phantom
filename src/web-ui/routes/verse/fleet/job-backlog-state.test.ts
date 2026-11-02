import { describe, expect, it } from 'vitest';
import { jobBacklogState } from './job-backlog-state.js';

const job = 'RQ-PHX-EXAMPLE01';
const item = { number: 123, job, headRef: 'work/other', mergeStateStatus: 'DIRTY', suggestedAction: 'recut', classification: { reason: 'merge-conflict' } };
const read = (row: unknown = item) => ({ v: 1, source: 'ok', items: [row] });

describe('job backlog state', () => {
  it.each([
    ['DIRTY', 'recut', 'merge-conflict', 'danger', 'PR #123 · DIRTY · recut — conflicts with master'],
    ['BEHIND', 'refresh', 'base-moved', 'warn', 'PR #123 · BEHIND · refresh — needs an update to master'],
    ['BLOCKED', 'wait', 'checks-pending', 'warn', 'PR #123 · BLOCKED · wait — waiting on CI'],
    ['UNSTABLE', 'recut', 'required-check-failed', 'warn', 'PR #123 · UNSTABLE · recut — required checks failed'],
    ['CLEAN', 'merge', 'checks-green', 'ok', 'PR #123 · CLEAN · merge'],
    ['UNKNOWN', 'wait', 'github-computing', 'neutral', 'PR #123 · UNKNOWN · wait — github computing'],
    ['DRAFT', 'wait', 'draft', 'neutral', 'PR #123 · DRAFT · wait — draft'],
    ['HAS_HOOKS', 'merge', 'checks-green', 'neutral', 'PR #123 · HAS_HOOKS · merge'],
  ])('maps %s to %s advice', (state, action, reason, tone, text) => {
    expect(jobBacklogState(read({ ...item, mergeStateStatus: state, suggestedAction: action, classification: { reason } }), job.toLowerCase()))
      .toEqual({ number: 123, state, action, tone, text });
  });
  it('matches a head ref ending in the job id case insensitively', () => {
    expect(jobBacklogState(read({ ...item, job: null, headRef: `work/${job.toLowerCase()}` }), job)?.number).toBe(123);
  });
  it('ignores failed, incompatible, missing, and malformed reads', () => {
    expect(jobBacklogState({ v: 1, source: 'gh-failed', items: [item] }, job)).toBeNull();
    expect(jobBacklogState({ v: 2, source: 'ok', items: [item] }, job)).toBeNull();
    expect(jobBacklogState(read(), 'RQ-PHX-OTHER')).toBeNull();
    expect(jobBacklogState(read({ ...item, number: null }), job)).toBeNull();
    expect(jobBacklogState(null, job)).toBeNull();
  });
});
