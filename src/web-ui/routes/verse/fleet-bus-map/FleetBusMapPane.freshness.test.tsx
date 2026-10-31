import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { BusFeedData, BusHop } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import './fleet-bus-map.pane.js';
import { FleetBusMapPane } from './FleetBusMapPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const props = { visible: true } as PaneProps;
const hop = (id: string, from: string, to: string, inputTokens: number | null = null, outputTokens: number | null = null): BusHop =>
  ({ id, from, to, inputTokens, outputTokens });
const fixture = (hops: BusHop[], lastHopAt: string | null): BusFeedData => ({
  v: 1, hops, hopsDropped: 0, lastHopAt, events: [],
  sources: { hops: 'healthy', events: 'healthy' },
});
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows the last-hop age in the header', async () => {
  const lastHopAt = new Date(Date.now() - 3 * 60_000).toISOString();
  vi.mocked(apiGet).mockResolvedValue(fixture([hop('1', 'leader', 'builder', 10, 5)], lastHopAt));
  render(<FleetBusMapPane {...props} />);
  const header = await screen.findByText(/2 agents · 1 hops · in 10 \/ out 5 tokens/);
  expect(header).toHaveTextContent('last hop 3 min ago');
});

it('ends the empty state with "no hops recorded" when the feed never saw a hop', async () => {
  vi.mocked(apiGet).mockResolvedValue(fixture([], null));
  render(<FleetBusMapPane {...props} />);
  const message = await screen.findByText('No bus traffic in the recent window.');
  expect(message).toHaveTextContent('no hops recorded');
});

it('still ends the empty state with the last-hop age when the window is quiet', async () => {
  const lastHopAt = new Date(Date.now() - 12 * 60_000).toISOString();
  vi.mocked(apiGet).mockResolvedValue(fixture([], lastHopAt));
  render(<FleetBusMapPane {...props} />);
  const message = await screen.findByText('No bus traffic in the recent window.');
  expect(message).toHaveTextContent('last hop 12 min ago');
});

it('copies the full untruncated agent id and confirms', async () => {
  const longId = `lane-${'x'.repeat(60)}`;
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  vi.mocked(apiGet).mockResolvedValue(fixture([hop('1', longId, 'builder')], new Date().toISOString()));
  render(<FleetBusMapPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: `Copy agent id ${longId}` }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(longId));
  expect(await screen.findByText('Copied')).toHaveAttribute('role', 'status');
});

it('reports clipboard failure', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  vi.mocked(apiGet).mockResolvedValue(fixture([hop('1', 'leader', 'builder')], new Date().toISOString()));
  render(<FleetBusMapPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy agent id leader' }));
  expect(await screen.findByText('Copy failed')).toHaveAttribute('role', 'status');
});
