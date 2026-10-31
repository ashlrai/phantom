import { describe, expect, it } from 'vitest';
import type { ReleasePr, ReleasePrResult } from '../fleet/release-pr-query.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const pr: ReleasePr = {
  number: 42, title: 'Release candidate', version: '3.30.0', url: 'https://github.com/example/repo/pull/42',
  openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: 'MERGEABLE',
  checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: null }],
  failing: ['Dependency audit (root + Raycast)'], pending: 0, blocked: true, summary: 'blocked',
};
const result = (value: ReleasePr | null): ReleasePrResult => ({ kind: 'available', data: {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy',
  repos: [{ repo: 'example/repo', path: '/fake', pr: value, notes: [] }],
} });

describe('deriveReleaseNeedsYou', () => {
  it('names failing checks, limits them to three, and gives the age', () => {
    const items = deriveReleaseNeedsYou(result({ ...pr, failing: ['audit', 'test', 'build', 'extra'] }), now);
    expect(items).toEqual([{ id: 'release-blocked:example/repo:42', severity: 'urgent',
      title: 'Release 3.30.0 is blocked', detail: 'audit, test, build failing · open 3 d',
      nextStep: 'Open the release PR; Merge Gate reruns after the fix lands', target: 'fleet' }]);
  });
  it('marks pending checks and merge conflicts as attention', () => {
    const pending = { ...pr, version: null, checks: [{ name: 'build', state: 'pending' as const, url: null }], failing: [], pending: 1 };
    expect(deriveReleaseNeedsYou(result(pending), now)[0]).toMatchObject({ severity: 'attention', title: 'Release Release candidate is blocked', detail: '1 check pending · open 3 d' });
    expect(deriveReleaseNeedsYou(result({ ...pending, pending: 0, mergeable: 'CONFLICTING' }), now)[0]?.detail).toContain('Merge conflict');
  });
  it('omits unblocked, merged, missing and unavailable releases', () => {
    expect(deriveReleaseNeedsYou(result({ ...pr, blocked: false }), now)).toEqual([]);
    expect(deriveReleaseNeedsYou(result(null), now)).toEqual([]);
    expect(deriveReleaseNeedsYou({ kind: 'notInBuild' }, now)).toEqual([]);
    expect(deriveReleaseNeedsYou(undefined, now)).toEqual([]);
  });
  it('derives an item for each blocked repository', () => {
    const data = result(pr);
    if (data.kind !== 'available') throw new Error('fixture');
    data.data.repos.push({ repo: 'example/other', path: '/fake', pr, notes: [] });
    expect(deriveReleaseNeedsYou(data, now).map(item => item.id)).toEqual(['release-blocked:example/repo:42', 'release-blocked:example/other:42']);
  });
});
