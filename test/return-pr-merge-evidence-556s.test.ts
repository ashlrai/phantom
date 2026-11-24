import { describe, expect, it } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const row: ReturnEvidenceRow = {
  claimId: 'fake', repo: 'example/project', result: 'VERIFIED', evidenceKind: 'pr', pr: 42, head: 'ABC1234',
};
const head = { sha: `abc1234${'0'.repeat(33)}` };

async function check(body: unknown, claim = row) {
  const report = await checkReturnPrs([claim], { gh: async () => JSON.stringify(body) });
  return report.checked[0];
}

describe('return PR merge evidence', () => {
  it.each([
    ['false with timestamp', { merged: false, merged_at: '2026-11-12T00:00:00Z', head }],
    ['open with merged', { state: 'open', merged: true, head }],
    ['open with timestamp', { state: 'open', merged_at: '2026-11-12T00:00:00Z', head }],
    ['true with null timestamp', { merged: true, merged_at: null, head }],
    ['invalid timestamp', { merged: true, merged_at: 'private-invalid', head }],
    ['empty timestamp', { merged: true, merged_at: '', head }],
    ['impossible timestamp', { merged: true, merged_at: '2026-02-30T00:00:00Z', head }],
    ['invalid observed head', { merged: true, head: { sha: 'abc1234-private' } }],
    ['empty observed head', { merged: true, head: { sha: '' } }],
    ['invalid merge flag', { merged: 'private', head }],
    ['invalid state', { merged: true, state: 'private', head }],
  ])('rejects %s with a fixed reason', async (_label, body) => {
    const result = await check(body);
    expect(result).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-evidence', observedHead: null, mergedAt: null });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('rejects a malformed claimed head', async () => {
    expect(await check({ merged: true, head }, { ...row, head: 'abc123g' }))
      .toMatchObject({ verdict: 'unknown', reason: 'invalid-response-evidence' });
  });
  it('accepts valid merged evidence and abbreviated case-insensitive heads', async () => {
    expect(await check({ state: 'closed', merged: true, merged_at: '2026-11-12T00:00:00Z', head }))
      .toMatchObject({ verdict: 'merged-at-head' });
  });
  it('accepts omitted optional fields but does not invent a missing head', async () => {
    expect(await check({ merged: true, head })).toMatchObject({ verdict: 'merged-at-head', mergedAt: null });
    expect(await check({ merged: true })).toMatchObject({ verdict: 'unknown', reason: 'unparseable' });
    expect(await check({ merged: true, head }, { ...row, head: null })).toMatchObject({ verdict: 'merged-other-head' });
  });
  it.each(['open', 'closed'])('preserves %s unmerged responses', async state => {
    expect(await check({ state, merged: false, merged_at: null, head }))
      .toMatchObject({ verdict: state === 'open' ? 'open' : 'closed-unmerged' });
  });
});
