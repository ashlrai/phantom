import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { BusFeedData } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane, panesFor } from '../panes/pane-registry.js';
import './fleet-bus.pane.js';
import { FleetBusPane } from './FleetBusPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const props = { visible: true } as PaneProps;
const fixture = (): BusFeedData => ({
  v: 1, hops: [{ id: '1', from: 'alpha', to: 'beta', inputTokens: 1234, outputTokens: null }],
  hopsDropped: 2, lastHopAt: null,
  events: [{ at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'Launched' },
    { at: '2026-01-02T00:00:00Z', kind: 'inbox', text: 'Mason says hello' }],
  sources: { hops: 'healthy', events: 'healthy' },
});
const rows = () => within(screen.getByRole('list', { name: 'Bus event feed' })).getAllByRole('listitem');
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('registers without a chat and shows totals, interjections, filters, and newest events', async () => {
  expect(getPane('fleet-bus')?.needsSession).toBe(false);
  expect(panesFor({ sessionId: null, session: null, roots: [] }).some(pane => pane.id === 'fleet-bus')).toBe(true);
  vi.mocked(apiGet).mockResolvedValue(fixture());
  render(<FleetBusPane {...props} />);
  expect(await screen.findByText(`1 hops · in ${1234..toLocaleString()} / out — tokens · 2 agents · hops dropped 2`)).toBeInTheDocument();
  expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/api/verse/fleet/live/bus?limit=50', undefined);
  expect(rows()[0]).toHaveTextContent('Mason says hello');
  expect(screen.getByRole('listitem', { name: 'Interjection' })).toHaveTextContent('Mason says hello');
  fireEvent.click(screen.getByRole('button', { name: 'launch' }));
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent('Launched');
});

it('shows one notice for degraded sources', async () => {
  const data = fixture(); data.sources = { hops: 'degraded', events: 'missing' }; data.hopsDropped = 0;
  vi.mocked(apiGet).mockResolvedValue(data);
  render(<FleetBusPane {...props} />);
  expect(await screen.findByText('Bus data may be incomplete.')).toBeInTheDocument();
  expect(screen.queryByText(/hops dropped/)).not.toBeInTheDocument();
});

it('freezes events while paused and retains arrivals until resumed', async () => {
  const data = fixture(); vi.mocked(apiGet).mockResolvedValue(data);
  render(<FleetBusPane {...props} />);
  await screen.findByText('Launched');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  const next: BusFeedData = { ...data, events: [...data.events, { at: '2026-01-03T00:00:00Z', kind: 'inbox', text: 'New message' }] };
  await act(async () => { await refetchQuery('verse-fleet-bus-feed', async () => next, true); });
  expect(screen.queryByText('New message')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume · 1 new' })).toBeInTheDocument();
  await act(async () => { await refetchQuery('verse-fleet-bus-feed', async () => data, true); });
  fireEvent.click(screen.getByRole('button', { name: 'Resume · 1 new' }));
  expect(rows()[0]).toHaveTextContent('New message');
});

it('fetches and polls only while visible', async () => {
  vi.useFakeTimers(); vi.mocked(apiGet).mockResolvedValue(fixture());
  const view = render(<FleetBusPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(apiGet).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetBusPane {...props} />); });
  expect(apiGet).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(apiGet).toHaveBeenCalledTimes(2);
  view.rerender(<FleetBusPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(apiGet).toHaveBeenCalledTimes(2);
});

it('reports a missing route', async () => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('missing', 404, '/api/verse/fleet/live/bus'));
  render(<FleetBusPane {...props} />);
  expect(await screen.findByText('Bus not in this build')).toBeInTheDocument();
});
