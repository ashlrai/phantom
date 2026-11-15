import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { OrderStateStrip } from './OrderStateStrip.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const mk = (state: string, i: number, owner?: unknown) => ({
  at: '2026-11-13T17:13:00.000Z', source: 'slack', key: `order-fake-${i}`, state,
  asOf: '2026-11-13T17:14:00.000Z', evidenceSource: 'ledger', missing: [], pr: null, ...(owner === undefined ? {} : { owner }),
});

it('shows the owner and "no owner"', async () => {
  const b = { v: 1, asOf: '2026-11-13T17:15:00.000Z', sources: {}, orders: [
    mk('ASSIGNED', 1, { job: 'RQ-PHX-FOO', lane: 'devin' }), mk('RECEIVED', 2, null), mk('RECEIVED', 3)] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status: 200 })));
  render(<OrderStateStrip />);
  await waitFor(() => expect(screen.getByText('owner: RQ-PHX-FOO (devin)')).toBeInTheDocument());
  expect(screen.getAllByText('owner: no owner')).toHaveLength(2);
});
