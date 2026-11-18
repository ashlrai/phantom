import { expect, it } from 'vitest';
import { narrowClaimNotices } from './claim-notices-model.js';

it('keeps malformed Slack delivery evidence unknown while retaining valid claim notices', () => {
  const result = narrowClaimNotices({
    v: 1,
    source: 'unreadable',
    slackConfigured: false,
    sent: { total: Number.MAX_SAFE_INTEGER + 1, recent: [
      { state: 'sent', claimId: 'fake-claim', at: 100, delivery: 'sent' },
      { state: 'sent', claimId: 'fake-invalid-time', at: Infinity, delivery: 'slack-sent' },
    ] },
    delivery: { sendStore: 'sent', slackSent: -1, noReceipt: 0.5, unknown: NaN },
    unbound: { state: 'known', total: -1, rows: [
      { claimId: 'fake-unbound', repo: 'example/fake', agent: 'fake-agent', claimedAt: 99 },
      { claimId: 'fake-invalid-time', repo: 'example/fake', agent: 'fake-agent', claimedAt: NaN },
    ] },
  });

  expect(result).toMatchObject({
    source: 'unreadable',
    slackConfigured: false,
    sentTotal: 0,
    delivery: { sendStore: 'unknown', slackSent: 0, noReceipt: 0, unknown: 0 },
    recent: [{ state: 'sent', claimId: 'fake-claim', at: 100, delivery: 'unknown' }],
    unbound: { state: 'known', total: 1, rows: [
      { claimId: 'fake-unbound', repo: 'example/fake', agent: 'fake-agent', claimedAt: 99 },
    ] },
  });
});
