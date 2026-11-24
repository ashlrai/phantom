import { describe, expect, it, vi } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const row: ReturnEvidenceRow = {
  claimId: 'fake-claim', repo: 'Example/Project', result: 'VERIFIED', evidenceKind: 'pr',
  pr: 42, head: 'abc1234',
};
const merged = {
  number: 42, base: { repo: { full_name: 'Example/Project' } },
  state: 'closed', merged: true, merged_at: '2026-11-12T00:00:00Z',
  head: { sha: 'abc1234567890000000000000000000000000000', repo: { full_name: 'fork/Project' } },
};

describe('return PR response identity', () => {
  async function check(body: unknown) {
    const gh = vi.fn(async () => JSON.stringify(body));
    const report = await checkReturnPrs([row], { gh });
    expect(report.authority).toBe('none');
    expect(gh.mock.calls).toEqual([[['api', '-H', 'Accept: application/vnd.github+json', 'repos/Example/Project/pulls/42']]]);
    return report.checked[0];
  }

  it('accepts matching identity and a fork head repository', async () => {
    expect(await check(merged)).toMatchObject({ verdict: 'merged-at-head' });
  });
  it('accepts repository casing differences', async () => {
    expect(await check({ ...merged, base: { repo: { full_name: 'example/PROJECT' } } })).toMatchObject({ verdict: 'merged-at-head' });
  });
  it('accepts omitted identity for minimal fixtures', async () => {
    expect(await check({ merged: true, head: merged.head })).toMatchObject({ verdict: 'merged-at-head' });
  });
  it.each([
    ['different PR', { ...merged, number: 43 }],
    ['different base', { ...merged, base: { repo: { full_name: 'other/project' } } }],
    ['malformed number', { ...merged, number: '42' }],
    ['malformed base', { ...merged, base: null }],
    ['malformed repo', { ...merged, base: { repo: null } }],
    ['malformed full name', { ...merged, base: { repo: { full_name: null } } }],
    ['open with conflicting identity', { ...merged, number: 43, merged: false, merged_at: null, state: 'open' }],
    ['closed with conflicting identity', { ...merged, number: 43, merged: false, merged_at: null, state: 'closed' }],
  ])('rejects %s with a sanitized unknown', async (_label, body) => {
    expect(await check(body)).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-identity', observedHead: null, mergedAt: null });
  });
});
