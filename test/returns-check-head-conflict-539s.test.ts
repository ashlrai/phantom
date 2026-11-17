import { describe, expect, it, vi } from 'vitest';
import { checkReturnPrs, type ReturnEvidenceRow } from '../src/core/fleet/return-pr-check.js';

const sha = 'abc1234def567890abcdef1234567890abcdef12';
const row = (claimId: string, head: string | null, repo = 'example/demo'): ReturnEvidenceRow => ({
  claimId, head, repo, pr: 539, result: 'VERIFIED', evidenceKind: 'pr',
});
const merged = () => vi.fn(async () => JSON.stringify({
  state: 'closed', merged: true, merged_at: '2026-11-17T12:00:00Z', head: { sha },
}));

describe('return head conflict evidence (539s)', () => {
  it.each([false, true])('keeps both claims and verdicts, reversed=%s', async reverse => {
    const rows = [row('matching', 'ABC1234'), row('conflicting', '9998887', 'Example/Demo')];
    if (reverse) rows.reverse();
    const report = await checkReturnPrs(rows, { gh: merged() });
    expect(report).toMatchObject({ authority: 'none', skipped: 0, truncated: false });
    expect(report.checked).toEqual(rows.map(r => ({
      claimId: r.claimId, repo: r.repo, pr: r.pr, head: r.head,
      verdict: r.claimId === 'matching' ? 'merged-at-head' : 'merged-other-head',
      observedHead: sha, mergedAt: '2026-11-17T12:00:00Z',
    })));
  });
  it('deduplicates equivalent evidence while preserving distinct repos and heads', async () => {
    const gh = merged();
    const report = await checkReturnPrs([
      row('first', 'abc1234'), row('duplicate', 'ABC1234', 'Example/Demo'),
      row('other-repo', 'abc1234', 'other/demo'), row('missing', null), row('short', 'abc'),
    ], { gh });
    expect(report.checked.map(r => [r.claimId, r.verdict])).toEqual([
      ['first', 'merged-at-head'], ['other-repo', 'merged-at-head'],
      ['missing', 'merged-other-head'], ['short', 'merged-other-head'],
    ]);
    expect(gh.mock.calls).toHaveLength(4);
    expect(report).toMatchObject({ skipped: 1, truncated: false });
  });
  it.each([0, 1, 2])('counts conflicting heads against limit %s', async limit => {
    const gh = merged();
    const report = await checkReturnPrs([
      row('first', 'abc1234'), row('duplicate', 'abc1234'), row('conflict', '9998887'),
    ], { gh, limit });
    expect(report.checked.map(r => r.claimId)).toEqual(['first', 'conflict'].slice(0, limit));
    expect(report).toMatchObject({ skipped: 3 - limit, truncated: limit < 2 });
    expect(gh.mock.calls).toHaveLength(limit);
  });
  it('keeps failures sanitized and never reads invalid repos', async () => {
    const gh = vi.fn(async () => { throw new Error('private failure detail'); });
    const report = await checkReturnPrs([
      row('a', 'abc1234'), row('b', '9998887'),
      row('invalid-a', 'abc1234', 'bad_repo/demo'), row('invalid-b', '9998887', 'bad_repo/demo'),
    ], { gh });
    expect(report.checked.map(r => [r.claimId, r.verdict, r.reason, r.observedHead])).toEqual([
      ['a', 'unknown', 'read-failed', null], ['b', 'unknown', 'read-failed', null],
      ['invalid-a', 'unknown', 'invalid-repo', null], ['invalid-b', 'unknown', 'invalid-repo', null],
    ]);
    expect(gh.mock.calls).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('private failure detail');
    expect(report).toMatchObject({ authority: 'none', skipped: 0, truncated: false });
  });
  it('keeps conflicting provenance when the deadline prevents reads', async () => {
    const gh = merged();
    const report = await checkReturnPrs([row('a', 'abc1234'), row('b', '9998887')], { gh, timeoutMs: 0 });
    expect(report.checked.map(r => [r.claimId, r.reason, r.verdict])).toEqual([
      ['a', 'deadline', 'unknown'], ['b', 'deadline', 'unknown'],
    ]);
    expect(gh).not.toHaveBeenCalled();
  });
});
