import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const raw = (over: object = {}) => ({ v: 1, source: 'ok', bindings: 1,
  sent: { total: 0, recent: [] }, delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
  pending: [], slackConfigured: true,
  unbound: { state: 'known', total: 2, rows: [
    { claimId: 'claim-fake-b', repo: 'fake-org/fake-repo', agent: 'fake-agent', claimedAt: NOW - 60_000 },
    { claimId: 'claim-fake-d', repo: 'fake-org/fake-repo', agent: 'fake-agent', claimedAt: NOW - 120_000 }] },
  ...over });
const render447 = (over?: object) => render(<ClaimNoticesBody view={narrowClaimNotices(raw(over))!} nowMs={NOW} />);

it('renders the unbound heading, rows and the literal bind command', () => {
  render447();
  expect(screen.getByText('2 live claims have no Slack thread; their notices are dropped')).toBeInTheDocument();
  const list = screen.getByRole('list', { name: 'Claims with no Slack thread' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(within(list).getByText('claim-fake-b')).toBeInTheDocument();
  expect(within(list).getByText('ashlr fleet claim-bind claim-fake-b --repo fake-org/fake-repo --thread <threadKey>')).toBeInTheDocument();
  expect(screen.queryByText('Unbound claims: unknown')).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Bind' })).toHaveLength(2);
});

it('shows one unknown status line when unbound is unknown', () => {
  render447({ unbound: { state: 'unknown', total: 0, rows: [] } });
  expect(screen.getByText('Unbound claims: unknown')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Claims with no Slack thread' })).toBeNull();
});

it('renders nothing extra when the known count is 0', () => {
  render447({ unbound: { state: 'known', total: 0, rows: [] } });
  expect(screen.queryByRole('list', { name: 'Claims with no Slack thread' })).toBeNull();
  expect(screen.queryByText('Unbound claims: unknown')).toBeNull();
});

it('narrows an old payload without unbound to unknown and drops malformed rows', () => {
  const old = raw(); delete (old as Record<string, unknown>)['unbound'];
  expect(narrowClaimNotices(old)!.unbound).toEqual({ state: 'unknown', total: 0, rows: [] });
  const bad = narrowClaimNotices(raw({ unbound: { state: 'known', total: 2, rows: [
    { claimId: '', repo: 'r', agent: 'a', claimedAt: 1 }, { claimId: 'c', repo: 5, agent: 'a', claimedAt: 1 },
    { claimId: 'ok', repo: 'r', agent: 'a', claimedAt: 1 }] } }))!;
  expect(bad.unbound.rows.map(r => r.claimId)).toEqual(['ok']);
});
