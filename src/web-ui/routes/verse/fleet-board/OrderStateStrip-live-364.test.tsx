/** RQ-PHX-ORDERSTRIPLIVEHONEST364 — live-unavailable honesty in the strip. Fake ids only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { OrderStateStrip } from './OrderStateStrip.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const mk = (state: string, i: number) => ({
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: `order-fake-${i}`, state,
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null,
});
const body = (extra: Record<string, unknown>) => ({
  v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: {}, orders: [mk('ASSIGNED', 1), mk('VERIFIED', 2)], ...extra,
});
const stub = (b: unknown) => vi.stubGlobal('fetch', vi.fn(async () => json(b)));

it('live unavailable shows the notice and (unchecked) on ASSIGNED only', async () => {
  stub(body({ live: 'unavailable' }));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('VERIFIED')).toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent('Live workers unreadable · RUNNING not checked');
  const items = screen.getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('(unchecked)');
  expect(items[1]).not.toHaveTextContent('(unchecked)');
});

it('a healthy body shows neither', async () => {
  stub(body({ live: 'healthy' }));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('VERIFIED')).toBeInTheDocument());
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByText(/unchecked/)).toBeNull();
});
