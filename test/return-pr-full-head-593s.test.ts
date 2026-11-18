import { describe, expect, it } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const fullHead = 'abcdef0123456789abcdef0123456789abcdef01';
const row: ReturnEvidenceRow = {
  claimId: 'synthetic', repo: 'example/project', result: 'VERIFIED', evidenceKind: 'pr', pr: 42, head: 'abcdef0',
};

async function check(sha: string, claimHead = row.head) {
  const report = await checkReturnPrs([{ ...row, head: claimHead }], {
    gh: async () => JSON.stringify({ merged: true, merged_at: '2026-11-12T00:00:00Z', head: { sha } }),
  });
  return report.checked[0];
}

describe('return PR full upstream head evidence', () => {
  it.each([fullHead.slice(0, 7), fullHead.slice(0, 12), fullHead.slice(0, 39), `${fullHead}0`, `${fullHead.slice(0, 39)}g`])(
    'rejects malformed upstream head %s', async sha => {
      expect(await check(sha)).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-evidence', observedHead: null, mergedAt: null });
    },
  );

  it('accepts an abbreviated receipt against full upstream evidence, but not the reverse', async () => {
    expect(await check(fullHead)).toMatchObject({ verdict: 'merged-at-head', observedHead: fullHead });
    expect(await check(fullHead.slice(0, 7), fullHead)).toMatchObject({ verdict: 'unknown', reason: 'invalid-response-evidence', observedHead: null, mergedAt: null });
  });

  it('matches case-insensitively', async () => {
    expect(await check(fullHead.toUpperCase(), 'AbCdEf0')).toMatchObject({ verdict: 'merged-at-head' });
  });

  it('reports a different full head', async () => {
    expect(await check('123456789abcdef0123456789abcdef012345678')).toMatchObject({ verdict: 'merged-other-head' });
  });
});
