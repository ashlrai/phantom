import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { OrdersViewV1 } from '../../../../core/verse/fleet-orders-view.js';
import { OrdersCard } from './OrdersCard.js';

let data: OrdersViewV1;
vi.mock('../../../data/hooks.js', () => ({
  useQuery: () => ({ status: 'success', data }),
  useRefetch: () => vi.fn(),
}));

const summary = (over: Partial<OrdersViewV1['summary']>): OrdersViewV1['summary'] => ({
  schema: 'ashlr.intent-ledger/v1', present: true, sourceQuality: 'readable', countQuality: 'observed',
  items: 0, tracked: 0, merged: 0, shipped: 0, verified: 0, stale: 0, partial: 0, staleItems: [], ...over,
});
const view = (sum: OrdersViewV1['summary'], items: OrdersViewV1['items']): OrdersViewV1 => ({ v: 1, observedAt: '2026-11-09T12:00:00.000Z', summary: sum, items });
const row = (id: string, status: OrdersViewV1['items'][number]['status'], stale: boolean, extra = {}) =>
  ({ id, title: `Ship the example release ${id}`, status, rq: [], prs: [], lastTouchedAt: '2026-11-01T00:00:00.000Z', stale, ...extra });

it('shows the headline, marks gone-quiet rows first, and renders RQ keys and PRs', () => {
  data = view(summary({ items: 3, shipped: 1, verified: 1, stale: 1 }), [
    row('quiet', 'queued', true, { rq: ['RQ-EXAMPLE-1'] }),
    row('shipped', 'shipped', false, { prs: [{ repo: 'ashlrai/phantom', number: 12, state: 'merged' }] }),
    row('verified', 'verified', false),
  ]);
  const { container } = render(<OrdersCard visible />);
  expect(screen.getByText('3 orders · 1 shipped · 1 verified · 1 gone quiet')).toBeTruthy();
  const items = container.querySelectorAll('li');
  expect(items).toHaveLength(3);
  expect(items[0]!.textContent).toContain('Gone quiet');
  expect(items[0]!.textContent).toContain('Ship the example release quiet');
  expect(items[0]!.textContent).toContain('RQ-EXAMPLE-1');
  expect(items[1]!.textContent).not.toContain('Gone quiet');
  expect(items[1]!.textContent).toContain('phantom#12');
});

it('says no orders are tracked when the ledger is missing', () => {
  data = view(summary({ present: false, sourceQuality: 'missing' }), []);
  render(<OrdersCard visible />);
  expect(screen.getByText('No orders are tracked yet.')).toBeTruthy();
});

it('says orders are unavailable rather than showing zero', () => {
  data = view(summary({ sourceQuality: 'unavailable', countQuality: 'unknown' }), []);
  render(<OrdersCard visible />);
  expect(screen.getByText('Orders are unavailable right now.')).toBeTruthy();
});
