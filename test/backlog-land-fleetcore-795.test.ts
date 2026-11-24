import { describe, expect, it, vi } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const head = 'a'.repeat(40);
const rows: ReturnEvidenceRow[] = [1, 2].map(pr => ({
  claimId: `fake-claim-${pr}`, repo: 'example/demo', result: 'VERIFIED', evidenceKind: 'pr', pr, head,
}));
const merged = JSON.stringify({ state: 'closed', merged: true, merged_at: '2026-11-01T00:00:00Z', head: { sha: head } });

describe('preserved return check observation deadline', () => {
  it('retains an on-time merge and expires a later read settling at the shared deadline', async () => {
    let clock = 1_000;
    const gh = vi.fn(async () => {
      clock += gh.mock.calls.length === 1 ? 99 : 1;
      return merged;
    });
    const report = await checkReturnPrs(rows, { gh, now: () => clock, timeoutMs: 100 });
    expect(gh).toHaveBeenCalledTimes(2);
    expect(report.checked).toEqual([
      { claimId: 'fake-claim-1', repo: 'example/demo', pr: 1, head,
        verdict: 'merged-at-head', observedHead: head, mergedAt: '2026-11-01T00:00:00Z' },
      { claimId: 'fake-claim-2', repo: 'example/demo', pr: 2, head,
        verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline' },
    ]);
    expect(report).toMatchObject({ authority: 'none', asOf: new Date(1_100).toISOString(), skipped: 0, truncated: false });
  });

  it('expires late failed reads without exposing their errors or starting another read', async () => {
    let clock = 0;
    const gh = vi.fn(async () => { clock = 100; throw new Error('fake transport failure'); });
    const report = await checkReturnPrs(rows, { gh, now: () => clock, timeoutMs: 100 });
    expect(gh).toHaveBeenCalledTimes(1);
    expect(report.checked).toEqual(rows.map(({ claimId, repo, pr, head }) => ({
      claimId, repo, pr, head, verdict: 'unknown', observedHead: null, mergedAt: null, reason: 'deadline',
    })));
    expect(JSON.stringify(report)).not.toContain('fake transport failure');
  });
});
