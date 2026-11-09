import { describe, expect, it } from 'vitest';
import { eligible, evidence } from '../scripts/release-enqueue.mjs';

function candidate(): any {
  return {
    pr: { state: 'open', draft: false, base: { ref: 'master' }, labels: [{ name: 'autorelease: pending' }], head: { sha: 'abc' }, mergeable: true, mergeable_state: 'clean' },
    data: { state: 'OPEN', isDraft: false, baseRefName: 'master', headRefOid: 'abc', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', mergeQueueEntry: null },
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Merge Gate' }] } }],
    checks: [{ name: 'Merge Gate', head_sha: 'abc', status: 'completed', conclusion: 'success' }], statuses: [],
  };
}
describe('release enqueue admission', () => {
  it('accepts only a green required gate on the current clean release head', () => {
    expect(eligible(candidate())).toBe(true);
    for (const mutate of [
      (c: any) => { c.rules = []; },
      (c: any) => { c.checks = []; },
      (c: any) => { c.checks[0].head_sha = 'old'; },
      (c: any) => { c.checks[0].conclusion = 'failure'; },
      (c: any) => { c.statuses.push({ context: 'Merge Gate', state: 'pending' }); },
      (c: any) => { c.pr.mergeable_state = 'blocked'; },
      (c: any) => { c.data.mergeable = 'UNKNOWN'; },
      (c: any) => { c.data.mergeQueueEntry = { id: 'queued' }; },
      (c: any) => { c.pr.draft = true; },
      (c: any) => { c.pr.labels = []; },
      (c: any) => { c.data.headRefOid = 'changed'; },
    ]) { const c = candidate(); mutate(c); expect(eligible(c)).toBe(false); }
  });
  it('reports the surviving queue event and measured merge time', () => {
    const data = { createdAt: '2026-11-09T00:00:00Z', mergedAt: '2026-11-09T00:30:00Z', timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-09T00:20:00Z' }] } };
    expect(evidence(data)).toEqual({ queuedAt: '2026-11-09T00:20:00Z', mergedAt: data.mergedAt, openToMergeSeconds: 1800 });
    data.timelineItems.nodes.push({ __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T00:21:00Z' });
    expect(evidence(data).queuedAt).toBeNull();
  });
});
