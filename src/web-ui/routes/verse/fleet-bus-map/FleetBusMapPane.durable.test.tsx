import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusMapPane } from './FleetBusMapPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const feed = { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' } };
const page = { v: 1, status: 'ok', nextCursor: 3, messages: [
  { cursor: 1, receivedAt: 60_000, envelope: { id: 'mason-desktop-one', from: 'mason', to: 'leaders', priority: 'P1', ttl: 1000, body: { kind: 'interjection', text: 'hello' } } },
  { cursor: 2, receivedAt: 120_000, envelope: { id: 'mason-desktop-two', from: 'mason', to: 'leaders', priority: 'P1', ttl: 1000, body: { kind: 'interjection', text: 'again' } } },
  { cursor: 3, receivedAt: 120_000, envelope: { id: 'reply', from: 'leader-opus', to: 'mason', priority: 'P2', ttl: 1000, body: { kind: 'reply', text: 'hello' } } },
] };
const props = { visible: true } as PaneProps;
const durablePath = '/api/verse/agent-bus?after=0&limit=100';
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('renders durable interjections and replies alongside the existing map', async () => {
  vi.mocked(apiGet).mockImplementation(async path => path === durablePath ? page : feed);
  render(<FleetBusMapPane {...props} />);
  const table = await screen.findByRole('table', { name: 'Durable bus traffic by agent pair' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('mason → leaders');
  expect(within(rows[0]).getByText('2')).toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('leader-opus → mason');
  expect(within(rows[1]).getByText('1')).toBeInTheDocument();
  expect(screen.getByText(/Durable bus: 3 envelopes, 3 agents/)).toBeInTheDocument();
  expect(screen.getByText('No bus traffic in the recent window.')).toBeInTheDocument();
  expect(apiGet).toHaveBeenCalledWith(durablePath, undefined);
});

it('renders the unavailable line for a 404 while retaining the dispatch map', async () => {
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path === durablePath) throw new ApiError('missing', 404, path);
    return feed;
  });
  render(<FleetBusMapPane {...props} />);
  expect(await screen.findByText('Durable bus unavailable (dispatch off or store missing).')).toBeInTheDocument();
  expect(screen.getByText('No bus traffic in the recent window.')).toBeInTheDocument();
});

it('polls the durable bus only while visible and recovers from a 503', async () => {
  vi.useFakeTimers();
  let available = false;
  vi.mocked(apiGet).mockImplementation(async path => {
    if (path !== durablePath) return feed;
    if (!available) throw new ApiError('unavailable', 503, path);
    return { ...page, messages: [] };
  });
  const view = render(<FleetBusMapPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(apiGet).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetBusMapPane {...props} />); });
  expect(screen.getByText('Durable bus unavailable (dispatch off or store missing).')).toBeInTheDocument();
  available = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByText('No durable bus traffic in this page.')).toBeInTheDocument();
  view.rerender(<FleetBusMapPane {...props} visible={false} />);
  const calls = vi.mocked(apiGet).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(apiGet).toHaveBeenCalledTimes(calls);
});
