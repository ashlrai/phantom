import { describe, expect, it } from 'vitest';
import { mergeBacklogCreatedAt, planMergeBacklog, type MergeBacklogItem } from '../src/core/fleet/merge-backlog-plan.js';
import { newFleetMergeState, parseFleetPrGhState } from '../src/core/fleet/fleet-merge-state.js';

function pr(number: number, createdAt?: string, status = 'CLEAN'): MergeBacklogItem {
  return {
    repo: 'ashlrai/phantom', createdAt: mergeBacklogCreatedAt({ createdAt }), mergeState: { state: 'missing' },
    github: parseFleetPrGhState({
      number, createdAt, state: 'OPEN', headRefOid: 'a'.repeat(40),
      mergeable: status === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: status,
      statusCheckRollup: [{ __typename: 'StatusContext', state: 'SUCCESS' }],
    }),
  };
}
const limits = { merges: 1, recuts: 1 };
const numbers = (rows: MergeBacklogItem[]) => rows.map(row => row.github!.number);
const old = '2026-09-01T00:00:00Z';
const recent = '2026-10-31T00:00:00Z';

describe('merge age routing', () => {
  it('selects oldest eligible PRs before applying capacity, without mutating input', () => {
    const rows = [pr(1, recent), pr(2, old), pr(3, '2026-10-01T00:00:00Z')];
    const before = JSON.stringify(rows);
    const plan = planMergeBacklog(rows, limits);
    expect(numbers(plan.merges)).toEqual([2]);
    expect(numbers(plan.deferred)).toEqual([3, 1]);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('routes the oldest conflict for recut without consuming a merge slot', () => {
    const plan = planMergeBacklog([
      pr(1, recent, 'DIRTY'), pr(2, old, 'DIRTY'), pr(3, recent), pr(4, old, 'BEHIND'),
    ], limits);
    expect(numbers(plan.recuts)).toEqual([2]);
    expect(plan.recuts[0]!.classification.work).toBe('refix');
    expect(numbers(plan.merges)).toEqual([3]);
    expect(numbers(plan.refreshes)).toEqual([4]);
    expect(numbers(plan.deferred)).toEqual([1]);
  });

  it('suppresses duplicate merge and recut observations across repository casing', () => {
    const ready = pr(1, old);
    const conflict = pr(2, old, 'DIRTY');
    const plan = planMergeBacklog([
      ready, { ...ready, repo: 'AshlrAI/Phantom' }, conflict, pr(2, recent),
      { ...pr(1, recent), repo: 'ashlrai/verse' }, pr(3, recent, 'DIRTY'),
    ], limits);
    expect(plan.merges.map(row => row.repo)).toEqual(['ashlrai/verse']);
    expect(numbers(plan.recuts)).toEqual([3]);
    expect(plan.deferred.map(row => row.classification.reason)).toEqual(Array(4).fill('duplicate-pr-observation'));
  });

  it('keeps discovery order for ties and places missing or invalid ages last', () => {
    const plan = planMergeBacklog([pr(1), pr(2, '1'), pr(3, old), pr(4, old)], { merges: 10, recuts: 0 });
    expect(numbers(plan.merges)).toEqual([3, 4, 1, 2]);
  });

  it('uses recorded open time when GitHub age is unavailable', () => {
    const record = newFleetMergeState({
      key: 'age', kind: 'change', proposalId: 'age', revertsLandingId: null,
      repo: 'ashlrai/phantom', repoPath: '/phantom', enforcement: 'server', nowIso: old,
    });
    const row = pr(1);
    record.pr = {
      number: 1, nodeId: 'PR_1', repositoryId: 'R_1', branch: '', baseBranch: '',
      baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), treeSha: 'c'.repeat(40),
      ownerLane: false, ownerLaneReason: null, openedAt: old, ledgered: true,
      state: 'open', closedBy: null, nextCheckAt: null, checkBackoffMs: 60_000,
      checks: null, wouldMergeHeadSha: null,
    };
    row.mergeState = { state: 'ok', record };
    expect(numbers(planMergeBacklog([pr(2, recent), row], limits).merges)).toEqual([1]);
  });

  it('does not let age promote drafts or pending checks', () => {
    const draft = pr(1, old);
    draft.github!.isDraft = true;
    const pending = pr(2, old);
    pending.github!.checks = 'pending';
    const plan = planMergeBacklog([draft, pending, pr(3, recent)], limits);
    expect(numbers(plan.merges)).toEqual([3]);
    expect(plan.recuts).toEqual([]);
  });
});
