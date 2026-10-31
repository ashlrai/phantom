import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { BusFeed } from './BusFeed.js';
import { busFeedQuery } from './bus-feed-queries.js';

const path = '/api/verse/fleet/live/bus';
const now = Date.parse('2026-10-31T12:02:10Z');
const fixture = {
  v: 1, hops: [], hopsDropped: 0, lastHopAt: null,
  events: [{ at: '2026-10-31T12:01:00Z', kind: 'incident', text: 'Worker needs attention' }],
  sources: { hops: 'healthy', events: 'healthy' },
};

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps events and reports the last successful reading after a failed refetch', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  let fail = false;
  stubSurfaceFetch({ routes: { [path]: () => fail
    ? new Response('unavailable', { status: 500 })
    : new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json' } }) } });
  render(<BusFeed now={now} />);
  expect(await screen.findByText('Worker needs attention')).toBeInTheDocument();
  fail = true;
  await act(async () => { await refetchQuery(busFeedQuery.key, () => busFeedQuery.fetch()); });
  expect(screen.getByText('Worker needs attention')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(`Agent bus could not refresh · showing the reading from ${new Date(now).toLocaleTimeString('en-GB')}`);
});

it('shows unavailable when the first reading fails', async () => {
  stubSurfaceFetch({ routes: { [path]: () => new Response('unavailable', { status: 500 }) } });
  render(<BusFeed now={now} />);
  expect(await screen.findByText('Agent bus is unavailable.')).toBeInTheDocument();
});
