import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const raw = (over: object = {}) => ({ v: 1, source: 'ok', bindings: 3,
  sent: { total: 3, recent: [
    { state: 'VERIFIED', claimId: 'claim-ok', at: NOW - 1000, delivery: 'slack-sent' },
    { state: 'RELEASED', claimId: 'claim-missed', at: NOW - 2000, delivery: 'no-slack-receipt' },
    { state: 'BLOCKED', claimId: 'claim-fuzzy', at: NOW - 3000, delivery: 'unknown' }] },
  delivery: { sendStore: 'ok', slackSent: 1, noReceipt: 1, unknown: 1 },
  pending: [], slackConfigured: true, ...over });
const view = (over?: object) => narrowClaimNotices(raw(over))!;

it('renders the delivery word per recent row and the three counts', () => {
  render(<ClaimNoticesBody view={view()} nowMs={NOW} />);
  expect(screen.getByText('1 slack-sent · 1 no-slack-receipt · 1 unknown')).toBeInTheDocument();
  expect(screen.getByText('slack-sent')).toBeInTheDocument();
  expect(screen.getByText('no-slack-receipt')).toBeInTheDocument();
  expect(screen.getAllByText('unknown')).not.toHaveLength(0);
});

it('treats an absent delivery field on a row as unknown', () => {
  const old = raw();
  for (const row of old.sent.recent) delete (row as Record<string, unknown>)['delivery'];
  const narrowed = narrowClaimNotices(old)!;
  expect(narrowed.recent.map(r => r.delivery)).toEqual(['unknown', 'unknown', 'unknown']);
});

it('treats an absent delivery summary as unknown with counts derived from the rows', () => {
  const old = raw();
  delete (old as Record<string, unknown>)['delivery'];
  const narrowed = narrowClaimNotices(old)!;
  expect(narrowed.delivery).toEqual({ sendStore: 'unknown', slackSent: 1, noReceipt: 1, unknown: 1 });
  render(<ClaimNoticesBody view={narrowed} nowMs={NOW} />);
  expect(screen.getByText('1 slack-sent · 1 no-slack-receipt · 1 unknown')).toBeInTheDocument();
});

it('reports an invalid sendStore word as unknown', () => {
  const narrowed = narrowClaimNotices(raw({ delivery: { sendStore: 'bogus', slackSent: 2, noReceipt: 0, unknown: 1 } }))!;
  expect(narrowed.delivery.sendStore).toBe('unknown');
  expect(narrowed.delivery.slackSent).toBe(2);
});
