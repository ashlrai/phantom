import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { BusFeedData } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const fixture = (): BusFeedData => ({
  v: 1, hops: [{ id: '1', from: 'leader-opus', to: 'worker-terra', inputTokens: 1200, outputTokens: 34 }],
  hopsDropped: 0, lastHopAt: '2026-01-02T00:00:00Z', sources: { hops: 'healthy', events: 'healthy' },
  events: [{ at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'Launched' },
    { at: '2026-01-03T00:00:00Z', kind: 'inbox', text: 'Hello' }],
});
const rows = () => within(screen.getByRole('list', { name: 'Bus event feed' })).getAllByRole('listitem');
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); vi.mocked(apiGet).mockReset(); });

it('shows hops in the timeline and filters them with the Hops toggle', async () => {
  vi.mocked(apiGet).mockResolvedValue(fixture());
  render(<FleetBusPane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('leader-opus → worker-terra · 1.2k in / 34 out')).toBeInTheDocument();
  expect(rows()).toHaveLength(3);
  expect(rows()[1]).toHaveTextContent('hop');
  expect(rows()[1].querySelector('time')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Hops' }));
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toHaveTextContent('leader-opus → worker-terra');
});

it('holds hop arrivals while paused without recounting an updated group timestamp', async () => {
  const data = fixture(); vi.mocked(apiGet).mockResolvedValue(data);
  render(<FleetBusPane {...{ visible: true } as PaneProps} />);
  await screen.findByText(/leader-opus → worker-terra/);
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  const next: BusFeedData = { ...data, lastHopAt: '2026-01-04T00:00:00Z', hops: [...data.hops, { id: '2', from: 'worker-terra', to: 'leader-opus', inputTokens: 2, outputTokens: 3 }] };
  await act(async () => { await refetchQuery('verse-fleet-bus-feed', async () => next, true); });
  expect(screen.queryByText(/worker-terra → leader-opus/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Resume · 1 new' }));
  expect(screen.getByText(/worker-terra → leader-opus/)).toBeInTheDocument();
});
