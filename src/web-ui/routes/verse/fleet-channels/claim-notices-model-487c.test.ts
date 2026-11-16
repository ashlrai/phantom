import { expect, it } from 'vitest';
import { narrowClaimNotices } from './claim-notices-model.js';

it('returns null for a non-object, for v !== 1, and for a source outside ok/missing/unreadable', () => {
  expect(narrowClaimNotices(null)).toBeNull();
  expect(narrowClaimNotices('string')).toBeNull();
  expect(narrowClaimNotices(42)).toBeNull();
  expect(narrowClaimNotices({ v: 2, source: 'ok' })).toBeNull();
  expect(narrowClaimNotices({ v: 1, source: 'invalid' })).toBeNull();
});

it('handles older server without delivery field', () => {
  const result = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [
      { state: 'sent', claimId: 'claim-1', at: 1234567890, delivery: 'slack-sent' },
      { state: 'sent', claimId: 'claim-2', at: 1234567891, delivery: undefined }, // no delivery field
      { state: 'sent', claimId: 'claim-3', at: 1234567892, delivery: 'no-slack-receipt' }
    ]},
    delivery: undefined, // no delivery object
    bindings: 1,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] }
  })!;

  expect(result.delivery.sendStore).toBe('unknown');
  expect(result.delivery.slackSent).toBe(1);
  expect(result.delivery.noReceipt).toBe(1);
  expect(result.delivery.unknown).toBe(1);
  expect(result.recent).toHaveLength(3);
  expect(result.recent[0].delivery).toBe('slack-sent');
  expect(result.recent[1].delivery).toBe('unknown');
  expect(result.recent[2].delivery).toBe('no-slack-receipt');
});

it('drops recent rows with non-finite at or empty claimId', () => {
  const result = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [
      { state: 'sent', claimId: 'claim-1', at: 1234567890, delivery: 'slack-sent' },
      { state: 'sent', claimId: '', at: 1234567891, delivery: 'slack-sent' }, // empty claimId
      { state: 'sent', claimId: 'claim-3', at: 'not-a-number', delivery: 'slack-sent' } // invalid at
    ]},
    delivery: { sendStore: 'ok', slackSent: 1, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] }
  })!;

  expect(result.recent).toHaveLength(1);
  expect(result.recent[0].claimId).toBe('claim-1');
});

it('handles unbound field correctly', () => {
  // Missing unbound field
  const result1 = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: undefined
  })!;

  expect(result1.unbound.state).toBe('unknown');
  expect(result1.unbound.total).toBe(0);
  expect(result1.unbound.rows).toHaveLength(0);

  // unbound with state 'known' but no rows array
  const result2 = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: { state: 'known' }
  })!;

  expect(result2.unbound.state).toBe('unknown');
  expect(result2.unbound.total).toBe(0);
  expect(result2.unbound.rows).toHaveLength(0);

  // unbound with valid known state
  const result3 = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: { state: 'known', total: 1, rows: [
      { claimId: 'claim-1', repo: 'ashlrai/phantom', agent: 'dot', claimedAt: 1234567890 }
    ]}
  })!;

  expect(result3.unbound.state).toBe('known');
  expect(result3.unbound.total).toBe(1);
  expect(result3.unbound.rows).toHaveLength(1);
  expect(result3.unbound.rows[0].claimId).toBe('claim-1');
});

it('caps recent and pending rows at 20', () => {
  const recentRows = Array(25).fill(0).map((_, i) => ({
    state: 'sent',
    claimId: `claim-${i}`,
    at: 1234567890 + i,
    delivery: 'slack-sent'
  }));

  const pendingRows = Array(25).fill(0).map((_, i) => ({
    state: 'pending',
    threadKey: `thread-${i}`,
    text: `text-${i}`
  }));

  const result = narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: recentRows },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: pendingRows,
    unbound: { state: 'unknown', total: 0, rows: [] }
  })!;

  expect(result.recent).toHaveLength(20);
  expect(result.pending).toHaveLength(20);
});

it('reads slackConfigured as unknown when not boolean', () => {
  expect(narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] },
    slackConfigured: 'not-a-boolean'
  })!.slackConfigured).toBe('unknown');

  expect(narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] },
    slackConfigured: null
  })!.slackConfigured).toBe('unknown');
});

it('reads negative or fractional bindings as 0', () => {
  expect(narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: -1,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] }
  })!.bindings).toBe(0);

  expect(narrowClaimNotices({
    v: 1,
    source: 'ok',
    sent: { recent: [] },
    delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
    bindings: 1.5,
    pending: [],
    unbound: { state: 'unknown', total: 0, rows: [] }
  })!.bindings).toBe(0);
});
