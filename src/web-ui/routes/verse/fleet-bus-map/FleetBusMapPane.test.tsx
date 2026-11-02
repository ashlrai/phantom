import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import type { BusFeedData, BusHop } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane, panesFor } from '../panes/pane-registry.js';
import './fleet-bus-map.pane.js';
import { FleetBusMapPane } from './FleetBusMapPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const props = { visible: true } as PaneProps;
const hop = (id: string, from: string, to: string, inputTokens: number | null = null, outputTokens: number | null = null): BusHop =>
  ({ id, from, to, inputTokens, outputTokens });
const fixture = (hops: BusHop[] = [
  hop('1', 'leader', 'builder', 1200, 300),
  hop('2', 'leader', 'builder'),
  hop('3', 'builder', 'leader', 40, 2),
  hop('4', 'leader', 'scout', 60),
]): BusFeedData => ({
  v: 1, hops, hopsDropped: 3, lastHopAt: null, events: [],
  sources: { hops: 'healthy', events: 'healthy' },
});
const pairRows = () => within(screen.getByRole('table', { name: 'Bus traffic by agent pair' })).getAllByRole('row').slice(1);
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('registers without a chat and renders header, pair rows and share bars', async () => {
  expect(getPane('fleet-bus-map')?.needsSession).toBe(false);
  expect(getPane('fleet-bus-map')?.title).toBe('Bus map');
  expect(panesFor({ sessionId: null, session: null, roots: [] }).some(pane => pane.id === 'fleet-bus-map')).toBe(true);
  vi.mocked(apiGet).mockResolvedValue(fixture());
  render(<FleetBusMapPane {...props} />);
  expect(await screen.findByText(`3 agents · 4 hops · in ${(1300).toLocaleString()} / out 302 tokens · 3 hops dropped`)).toBeInTheDocument();
  expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/api/verse/fleet/live/bus?limit=50', undefined);
  const rows = pairRows();
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('leader → builder');
  expect(rows[0]).toHaveTextContent('2');
  expect(rows[0]).toHaveTextContent(`${(1200).toLocaleString()} / 300`);
  expect(rows[1]).toHaveTextContent('builder → leader');
  expect(rows[2]).toHaveTextContent('leader → scout');
  const bars = screen.getAllByLabelText(/of hops/);
  expect(bars).toHaveLength(3);
  expect(bars[0]).toHaveStyle('width: 50%');
  expect(bars[1]).toHaveStyle('width: 25%');
  const agents = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
  expect(agents.map(row => row.textContent)).toEqual(['leader3 sent · 1 received', 'builder1 sent · 2 received', 'scout0 sent · 1 received']);
});

it('keeps full agent ids in titles while showing truncated text', async () => {
  const longId = `lane-${'x'.repeat(60)}`;
  vi.mocked(apiGet).mockResolvedValue(fixture([hop('1', longId, 'builder', 1, 1)]));
  render(<FleetBusMapPane {...props} />);
  await screen.findByRole('table');
  for (const el of screen.getAllByTitle(longId)) expect(el.textContent).toContain('…');
  expect(screen.getAllByTitle(longId).length).toBeGreaterThanOrEqual(2); // pair cell + agents row
});

it('shows the empty state when the recent window has no traffic', async () => {
  const data = fixture([]); data.hopsDropped = 0;
  vi.mocked(apiGet).mockResolvedValue(data);
  render(<FleetBusMapPane {...props} />);
  expect(await screen.findByText('No bus traffic in the recent window.')).toBeInTheDocument();
  expect(screen.getByText('0 agents · 0 hops · in — / out — tokens')).toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('shows one notice when the hops source is degraded', async () => {
  const data = fixture(); data.sources = { hops: 'degraded', events: 'healthy' };
  vi.mocked(apiGet).mockResolvedValue(data);
  render(<FleetBusMapPane {...props} />);
  expect(await screen.findByText('Bus hop data may be incomplete.')).toBeInTheDocument();
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

it('fetches and polls every 10s only while visible', async () => {
  vi.useFakeTimers(); vi.mocked(apiGet).mockResolvedValue(fixture());
  const view = render(<FleetBusMapPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(apiGet).not.toHaveBeenCalled();
  await act(async () => { view.rerender(<FleetBusMapPane {...props} />); });
  expect(apiGet).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(apiGet).toHaveBeenCalledTimes(4);
  view.rerender(<FleetBusMapPane {...props} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(apiGet).toHaveBeenCalledTimes(4);
});

// Last: the 404 latches `busFeedMissing()` module state for the rest of the file.
it('reports a missing route', async () => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('missing', 404, '/api/verse/fleet/live/bus'));
  render(<FleetBusMapPane {...props} />);
  expect(await screen.findByText('Bus not in this build')).toBeInTheDocument();
});
