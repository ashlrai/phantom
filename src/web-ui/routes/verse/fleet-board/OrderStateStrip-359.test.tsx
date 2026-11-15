/** RQ-PHX-ORDERSTATESTRIP359 — strip renders from a mocked fetch. Fake ids only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { OrderStateStrip } from './OrderStateStrip.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const STATES = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
const mk = (state: string, i: number, over: Record<string, unknown> = {}) => ({
  at: '2026-11-13T17:13:00.000Z', source: i % 2 ? 'page' : 'slack', key: `order-fake-${i}`, state,
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null, ...over,
});
const stub = (res: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => res()));
const okBody = (orders: unknown[]) => ({ v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: {}, orders });

it('renders each state, missing evidence and a github PR link only', async () => {
  const orders = STATES.map((s, i) => mk(s, i, i === 3 ? { missing: ['ci green', 'review'] } : {}));
  orders[4] = mk('VERIFIED', 4, { pr: 'https://github.com/org-x/repo-y/pull/77' });
  orders[0] = mk('RECEIVED', 0, { pr: 'https://example.com/org-x/repo-y/pull/5' });
  orders[1] = mk('ASSIGNED', 1, { pr: 'not a url' });
  stub(() => json(okBody(orders)));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('VERIFIED')).toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'Your orders' })).toBeInTheDocument();
  for (const s of STATES) expect(screen.getByText(s)).toBeInTheDocument();
  expect(screen.getByText('missing: ci green, review')).toBeInTheDocument();
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute('href', 'https://github.com/org-x/repo-y/pull/77');
  expect(screen.queryByRole('button')).toBeNull();
});

it('caps rows at 20', async () => {
  stub(() => json(okBody(Array.from({ length: 25 }, (_, i) => mk('RUNNING', i)))));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getAllByText('RUNNING')).toHaveLength(20));
});

it('renders unavailable on 404', async () => {
  stub(() => json({}, 404));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('Order states unavailable')).toBeInTheDocument());
});

it('renders unavailable on a malformed body', async () => {
  stub(() => json({ v: 1, orders: 'x' }));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('Order states unavailable')).toBeInTheDocument());
});

it('renders unavailable on a network error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('Order states unavailable')).toBeInTheDocument());
});

it('renders the empty state', async () => {
  stub(() => json(okBody([])));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('No orders in range')).toBeInTheDocument());
});
