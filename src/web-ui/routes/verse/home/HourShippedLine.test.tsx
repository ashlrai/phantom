import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { HourShippedLine } from './HourShippedLine.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

it('shows the plain last-hour line from the hour feed', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json({ schema: 'fleet.shipped.v1', window: '1h', headline: 'Last hour: 5 shipped (3 fleet, 1 desktop/phone, 1 docs/site)', items: [] }));
  vi.stubGlobal('fetch', fetch); render(<HourShippedLine />);
  expect((await screen.findByTestId('hour-shipped')).textContent).toBe('Last hour: 5 shipped (3 fleet, 1 desktop/phone, 1 docs/site)');
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/shipped?since=1h');
});

it('stays hidden for an older server that answers with another payload', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: 'shipped.v1', areas: [] })));
  const { container } = render(<HourShippedLine />);
  await new Promise(done => setTimeout(done, 20));
  expect(container.textContent).toBe('');
});

it('a failed read says unknown, never nothing shipped', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
  render(<HourShippedLine />);
  expect((await screen.findByTestId('hour-shipped')).textContent).toMatch(/^Last hour: unknown/);
});
