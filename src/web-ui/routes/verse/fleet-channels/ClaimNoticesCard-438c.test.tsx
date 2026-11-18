import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

afterEach(cleanup);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const raw = (over: object = {}) => ({ v: 1, source: 'ok', bindings: 2,
  sent: { total: 5, recent: [{ state: 'VERIFIED', claimId: 'claim-fake-1', at: NOW - 120_000 }] },
  pending: [{ state: 'ASSIGNED', threadKey: 'T00000000/C00000000/1700000000.000100', text: 'ASSIGNED: fake-owner claim claim-fake-2' }],
  slackConfigured: true, pendingObservation: { state: 'known' }, ...over });
const view = (over?: object) => narrowClaimNotices(raw(over))!;

it('renders counts, state chips, sent rows and would-post rows', () => {
  render(<ClaimNoticesBody view={view()} nowMs={NOW} />);
  expect(screen.getByText('Slack thread notices')).toBeInTheDocument();
  expect(screen.getByText('2 bound threads · 5 posted · 1 waiting')).toBeInTheDocument();
  expect(screen.getByText('VERIFIED')).toBeInTheDocument();
  expect(screen.getByText('claim-fake-1')).toBeInTheDocument();
  expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
  expect(screen.getByText('would post')).toBeInTheDocument();
  expect(screen.getByText('ASSIGNED: fake-owner claim claim-fake-2')).toBeInTheDocument();
  expect(screen.getByText(/not that Slack delivered it/)).toBeInTheDocument();
  expect(screen.queryByText(/not configured/)).toBeNull();
});

it('says Slack is unconfigured', () => {
  render(<ClaimNoticesBody view={view({ slackConfigured: false })} nowMs={NOW} />);
  expect(screen.getByText('Slack is not configured; notices stay pending.')).toBeInTheDocument();
});

it('shows unreadable and missing as distinct states, never 0 posted', () => {
  const { unmount } = render(<ClaimNoticesBody view={view({ source: 'unreadable', bindings: 0, sent: { total: 0, recent: [] }, pending: [] })} nowMs={NOW} />);
  expect(screen.getByText('Claim-notice state is unreadable; counts are unknown.')).toBeInTheDocument();
  expect(screen.queryByText(/0 posted/)).toBeNull();
  unmount();
  render(<ClaimNoticesBody view={view({ source: 'missing', bindings: 0, sent: { total: 0, recent: [] }, pending: [] })} nowMs={NOW} />);
  expect(screen.getByText(/No claim-notice state found yet/)).toBeInTheDocument();
  expect(screen.queryByText(/0 posted/)).toBeNull();
});

it('rejects payloads that are not the v1 view', () => {
  expect(narrowClaimNotices({ v: 2 })).toBeNull();
  expect(narrowClaimNotices(raw({ source: 'weird' }))).toBeNull();
});
