import { expect, it } from 'vitest';
import { narrowClaimNotices } from './claim-notices-model.js';

it('derives delivery counts from valid rows without retaining mutable server objects', () => {
  const payload = {
    v: 1, source: 'ok',
    sent: { recent: [
      { state: 'sent', claimId: 'fake-sent', at: 100, delivery: 'slack-sent', extra: 'fake-extra' },
      { state: 'sent', claimId: 'fake-unconfirmed', at: 101, delivery: 'no-slack-receipt' },
      { state: 'sent', claimId: 'fake-legacy', at: 102, delivery: 'sent' },
      { state: 'sent', claimId: '', at: 103, delivery: 'slack-sent' },
    ] },
    pending: [{ state: 'pending', threadKey: 'fake-thread', text: 'Fake notice', extra: 'fake-extra' }],
    unbound: { state: 'known', total: 4, rows: [
      { claimId: 'fake-unbound', repo: 'example/fake', agent: 'fake-agent', claimedAt: 99, extra: 'fake-extra' },
    ] },
  };
  const original = structuredClone(payload);
  const result = narrowClaimNotices(payload)!;

  expect(result.delivery).toEqual({ sendStore: 'unknown', slackSent: 1, noReceipt: 1, unknown: 1 });
  expect(result.recent).toEqual([
    { state: 'sent', claimId: 'fake-sent', at: 100, delivery: 'slack-sent' },
    { state: 'sent', claimId: 'fake-unconfirmed', at: 101, delivery: 'no-slack-receipt' },
    { state: 'sent', claimId: 'fake-legacy', at: 102, delivery: 'unknown' },
  ]);
  expect(result.pending).toEqual([{ state: 'pending', threadKey: 'fake-thread', text: 'Fake notice' }]);
  expect(result.unbound).toEqual({ state: 'known', total: 4, rows: [
    { claimId: 'fake-unbound', repo: 'example/fake', agent: 'fake-agent', claimedAt: 99 },
  ] });
  expect(payload).toEqual(original);

  payload.sent.recent[0].claimId = 'fake-changed';
  payload.pending[0].text = 'Fake changed notice';
  payload.unbound.rows[0].agent = 'fake-changed-agent';
  expect(result.recent[0].claimId).toBe('fake-sent');
  expect(result.pending[0].text).toBe('Fake notice');
  expect(result.unbound.rows[0].agent).toBe('fake-agent');
});
