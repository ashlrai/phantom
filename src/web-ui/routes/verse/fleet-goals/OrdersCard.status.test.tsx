import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OrdersViewV1 } from '../../../../core/verse/fleet-orders-view.js';
import { ApiError } from '../../../data/client.js';
import { OrdersCard } from './OrdersCard.js';

let data: OrdersViewV1;
const refetch = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: 'success', data }), useRefetch: () => refetch }));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: () => 'fixture-token', touchMutationHold: vi.fn() }));
vi.mock('../../../data/client.js', async (orig) => ({ ...(await orig<typeof import('../../../data/client.js')>()), apiPost: (...a: unknown[]) => apiPost(...a), apiGet: vi.fn() }));

const row = (id: string, status: OrdersViewV1['items'][number]['status'], stale = false) =>
  ({ id, title: `Order ${id}`, status, rq: [], prs: [], lastTouchedAt: '2026-11-01T00:00:00.000Z', stale });

beforeEach(() => {
  refetch.mockReset(); apiPost.mockReset();
  data = {
    v: 1, observedAt: '2026-11-09T12:00:00.000Z',
    summary: { schema: 'ashlr.intent-ledger/v1', present: true, sourceQuality: 'readable', countQuality: 'observed', items: 4, tracked: 4, merged: 0, shipped: 0, verified: 0, stale: 1, partial: 0, staleItems: [] },
    items: [row('quiet', 'queued', true), row('open', 'proposed'), row('closed', 'closed'), row('dropped', 'superseded')],
  };
});
afterEach(cleanup);

it('posts Done with the order id, disables while running, then refetches', async () => {
  let finish!: (v: unknown) => void;
  apiPost.mockReturnValue(new Promise(r => { finish = r; }));
  render(<OrdersCard visible />);
  const button = screen.getByRole('button', { name: 'Done: Order open' }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  expect(apiPost).toHaveBeenCalledWith('/api/verse/fleet/runs/orders/status', { id: 'open', status: 'done' }, 'fixture-token');
  expect(refetch).not.toHaveBeenCalled();
  finish(row('open', 'closed'));
  await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button.disabled).toBe(false));
});

it('posts Drop for a stale row', async () => {
  apiPost.mockResolvedValue(row('quiet', 'superseded'));
  render(<OrdersCard visible />);
  fireEvent.click(screen.getByRole('button', { name: 'Drop: Order quiet' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith(expect.any(String), { id: 'quiet', status: 'dropped' }, 'fixture-token'));
});

it('shows the server error on that row only and does not refetch', async () => {
  apiPost.mockRejectedValue(new ApiError('POST failed', 400, '/x', 'Order is already closed.'));
  render(<OrdersCard visible />);
  fireEvent.click(screen.getByRole('button', { name: 'Done: Order open' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Order is already closed.');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(alert.closest('li')!.textContent).toContain('Order open');
  expect(refetch).not.toHaveBeenCalled();
});

it('offers Reopen only on closed rows, and Done/Drop only on open rows', async () => {
  render(<OrdersCard visible />);
  const items = Array.from(document.querySelectorAll('li'));
  const labels = (i: number) => Array.from(items[i]!.querySelectorAll('button')).map(b => b.textContent);
  expect(labels(0)).toEqual(['Done', 'Drop']);
  expect(labels(1)).toEqual(['Done', 'Drop']);
  expect(labels(2)).toEqual(['Reopen']);
  expect(labels(3)).toEqual(['Reopen']);
  apiPost.mockResolvedValue(row('closed', 'queued'));
  fireEvent.click(screen.getByRole('button', { name: 'Reopen: Order closed' }));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith(expect.any(String), { id: 'closed', status: 'queued' }, 'fixture-token'));
});
