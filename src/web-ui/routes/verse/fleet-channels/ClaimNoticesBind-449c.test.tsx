import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const refetchSpy = vi.hoisted(() => vi.fn());
const postSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../data/hooks.js', async (orig) => ({ ...(await orig<object>()), useRefetch: () => refetchSpy }));
vi.mock('../../../data/auth-store.js', async (orig) => ({ ...(await orig<object>()), getMutationToken: () => 'fake-token', touchMutationHold: () => undefined }));
vi.mock('../../../data/client.js', async (orig) => ({ ...(await orig<object>()), apiPost: postSpy }));

import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { narrowClaimNotices } from './claim-notices-model.js';
import { ClaimNoticesBody } from './ClaimNoticesCard.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const view = narrowClaimNotices({ v: 1, source: 'ok', bindings: 0,
  sent: { total: 0, recent: [] }, delivery: { sendStore: 'ok', slackSent: 0, noReceipt: 0, unknown: 0 },
  pending: [], slackConfigured: true,
  unbound: { state: 'known', total: 1, rows: [{ claimId: 'claim-fake-b', repo: 'fake-org/fake-repo', agent: 'fake-agent', claimedAt: NOW - 60_000 }] } })!;
const THREAD = 'T00000000/C00000000/1700000000.000100';

beforeEach(() => { refetchSpy.mockReset(); postSpy.mockReset(); });
afterEach(cleanup);
const open = () => render(<ClaimNoticesBody view={view} nowMs={NOW} />);
const submit = (thread: string) => {
  fireEvent.change(screen.getByLabelText('Slack thread'), { target: { value: thread } });
  fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
};

it('keeps the CLI hint and disables Bind for a bad thread', () => {
  open();
  expect(screen.getByText(/ashlr fleet claim-bind claim-fake-b/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Slack thread'), { target: { value: 'nope' } });
  expect(screen.getByRole('button', { name: 'Bind' })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Slack thread').closest('form')!);
  expect(postSpy).not.toHaveBeenCalled();
});

it('posts, shows bound and refetches', async () => {
  postSpy.mockResolvedValue({ ok: true, outcome: 'bound' });
  open(); submit(THREAD);
  expect(screen.getByRole('button', { name: 'Bind' })).toBeDisabled();
  const row = screen.getByRole('list', { name: 'Claims with no Slack thread' });
  await waitFor(() => expect(within(row).getByText('bound')).toBeInTheDocument());
  expect(postSpy).toHaveBeenCalledWith('/api/verse/fleet/coordination-claims/bind',
    { claimId: 'claim-fake-b', repo: 'fake-org/fake-repo', thread: THREAD }, 'fake-token');
  expect(refetchSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByText('claim-fake-b')).toBeInTheDocument(); // no optimistic removal
});

it('shows already bound for unchanged', async () => {
  postSpy.mockResolvedValue({ ok: true, outcome: 'unchanged' });
  open(); submit(THREAD);
  expect(await screen.findByText('already bound')).toBeInTheDocument();
});

it('shows not-found for the route 404 and the newer-host text for a missing route', async () => {
  postSpy.mockRejectedValueOnce(new ApiError('x', 404, 'p', null, 'not-found', { ok: false, outcome: 'not-found' }));
  open(); submit(THREAD);
  expect(await screen.findByText('not-found')).toBeInTheDocument();
  expect(refetchSpy).not.toHaveBeenCalled();
  postSpy.mockRejectedValueOnce(new DispatchDisabledError('p'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Bind' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
  expect(await screen.findByText('Binding from the console needs a newer host; use the CLI hint.')).toBeInTheDocument();
  expect(screen.queryByText('bound')).toBeNull();
});
