import { describe, expect, it } from 'vitest';
import { planClaimThreadNotices, type ClaimThreadSnapshot, type ClaimThreadBinding } from '../src/core/fleet/claim-thread-notice.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const claim = { id: 'claim-fake-1', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-owner',
  claimedAt: now - 1000, expiresAt: now + 1000 };
const binding: ClaimThreadBinding = { claimId: claim.id, repo: claim.repo,
  threadKey: 'T000FAKE/C000FAKE/1700000000.000001', pr: 123, head: 'abcdef1234567890' };
const snapshot = (over: Partial<ClaimThreadSnapshot> = {}): ClaimThreadSnapshot =>
  ({ state: 'known', claims: [], messages: [], asOf: now, ...over });
const active = () => snapshot({ claims: [claim] });
const receipt = (evidence = 'pr #123 head abcdef1234567890', result = 'VERIFIED') => ({
  id: `return-${claim.id}`, from: claim.agent, to: 'all', at: now, expiresAt: now + 5000,
  body: `RESULT ${result} ${claim.repo} claim ${claim.id} task "fake task": ${evidence}`,
});
const plan = (prev: ClaimThreadSnapshot, next: ClaimThreadSnapshot, bindings = [binding], at = now) =>
  planClaimThreadNotices(prev, next, bindings, at);

describe('claim thread notice planner (no transport)', () => {
  it('acquires once with owner, PR/head, receipt and as-of time', () => {
    const notices = plan(snapshot(), active());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ state: 'ASSIGNED', threadKey: binding.threadKey,
      dedupeKey: JSON.stringify(['ASSIGNED', claim.id, binding.head]) });
    expect(notices[0]!.text).toContain('fake-owner ashlrai/phantom#123@abcdef1');
    expect(notices[0]!.text).toContain(`claim ${claim.id}`);
    expect(notices[0]!.text).toContain(new Date(now).toISOString());
  });
  it('ignores replay and heartbeat-only lease renewal', () => {
    expect(plan(active(), active())).toEqual([]);
    expect(plan(active(), snapshot({ claims: [{ ...claim, expiresAt: now + 2000 }] }))).toEqual([]);
    const first = plan(snapshot(), active())[0]!;
    expect(plan(snapshot(), active(), [binding], now + 1)[0]!.dedupeKey).toBe(first.dedupeKey);
  });
  it('expires once even when an observer retains the expired claim', () => {
    const expired = snapshot({ claims: [claim], asOf: now + 1000 });
    expect(plan(active(), expired, [binding], now + 1000)).toMatchObject([{ state: 'RELEASED' }]);
    expect(plan(active(), expired, [binding], now + 1000)[0]!.text).toContain('claim expired');
    expect(plan(expired, expired, [binding], now + 1000)).toEqual([]);
    expect(plan(active(), snapshot({ asOf: now + 1000 }), [binding], now + 1000)).toHaveLength(1);
  });
  it('reports explicit release without inferring a blocker', () => {
    expect(plan(active(), snapshot())).toMatchObject([{ state: 'RELEASED' }]);
    expect(plan(active(), snapshot())[0]!.text).toContain('claim released');
  });
  it.each(['pr #123 head abcdef1234567890', 'tests 12 passed', 'artifact fake-build'])('returns VERIFIED evidence: %s', evidence => {
    const returned = snapshot({ messages: [receipt(evidence)] });
    const notices = plan(active(), returned);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ state: 'VERIFIED', threadKey: binding.threadKey });
    expect(notices[0]!.text).toContain(evidence);
    expect(plan(returned, returned)).toEqual([]);
  });
  it('uses the returned head rather than a stale bound head', () => {
    const notices = plan(active(), snapshot({ messages: [receipt('pr #456 head 1234567abcdef')] }));
    expect(notices[0]!.text).toContain('ashlrai/phantom#456@1234567');
    expect(notices[0]!.dedupeKey).toBe(JSON.stringify(['VERIFIED', claim.id, '1234567abcdef']));
  });
  it('reports BLOCKED with dependency evidence and suppresses the simultaneous release', () => {
    expect(plan(active(), snapshot({ messages: [receipt('dependency fake upstream', 'BLOCKED')] })))
      .toMatchObject([{ state: 'BLOCKED', text: expect.stringContaining('dependency fake upstream') }]);
  });
  it('drops unbound, mismatched and ambiguous bindings', () => {
    for (const bindings of [[], [{ ...binding, repo: 'other/fake' }],
      [binding, { ...binding, threadKey: 'T000FAKE/C000FAKE/1700000000.000002' }]]) {
      expect(plan(snapshot(), active(), bindings)).toEqual([]);
    }
  });
  it('keeps two items strictly in their own threads', () => {
    const other = { ...claim, id: 'claim-fake-2', repo: 'other/fake', agent: 'other-owner' };
    const otherBinding = { ...binding, claimId: other.id, repo: other.repo,
      threadKey: 'T000FAKE/C000FAKE/1700000000.000002' };
    const notices = plan(snapshot(), snapshot({ claims: [claim, other] }), [binding, otherBinding]);
    expect(notices.map(n => [n.threadKey, n.state])).toEqual([
      [binding.threadKey, 'ASSIGNED'], [otherBinding.threadKey, 'ASSIGNED'],
    ]);
    expect(notices[0]!.text).not.toContain(other.id);
    expect(notices[1]!.text).not.toContain(claim.id);
  });
  it('does not treat an unavailable read as a release or recover with an assignment flood', () => {
    expect(plan(active(), snapshot({ state: 'unknown' }))).toEqual([]);
    expect(plan(snapshot({ state: 'unknown' }), active())).toEqual([]);
    expect(plan(active(), active(), [binding], NaN)).toEqual([]);
  });
  it('rejects malformed, future and expired return receipts', () => {
    for (const message of [receipt('made up'), { ...receipt(), id: 'return-other' },
      { ...receipt(), at: now + 1 }, { ...receipt(), expiresAt: now }]) {
      expect(plan(snapshot(), snapshot({ messages: [message] }))).toEqual([]);
    }
  });
});
