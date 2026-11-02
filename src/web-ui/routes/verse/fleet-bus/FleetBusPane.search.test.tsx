import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import type { BusFeedData } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetBusPane } from './FleetBusPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const data: BusFeedData = {
  v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' },
  events: [
    { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'Job alpha started' },
    { at: '2026-01-02T00:00:00Z', kind: 'inbox', text: 'Mason: alpha is ready' },
    { at: '2026-01-03T00:00:00Z', kind: 'launch', text: 'Job beta started' },
    { at: '2026-01-04T00:00:00Z', kind: 'inbox', text: 'Mason says hello' },
    { at: '2026-01-05T00:00:00Z', kind: 'launch', text: 'Job gamma started' },
  ],
};
const rows = () => within(screen.getByRole('list', { name: 'Bus event feed' })).getAllByRole('listitem');
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockResolvedValue(data); });
afterEach(() => { cleanup(); vi.mocked(apiGet).mockReset(); });

it('combines search, kind and pause while retaining interjection markers', async () => {
  render(<FleetBusPane {...{ visible: true } as PaneProps} />);
  await screen.findByText('Job alpha started');
  const search = screen.getByRole('searchbox', { name: 'Filter bus events' });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  fireEvent.change(search, { target: { value: 'alpha' } });
  expect(rows()).toHaveLength(2);
  expect(screen.getByText('2 of 5 events')).toBeInTheDocument();
  expect(screen.getByRole('listitem', { name: 'Interjection' })).toHaveTextContent('alpha');
  fireEvent.click(screen.getByRole('button', { name: 'launch' }));
  expect(rows()).toHaveLength(1);
  expect(screen.getByText('1 of 5 events')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'launch' }));
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(search).toHaveValue('');
  expect(rows()).toHaveLength(5);
  expect(screen.queryByText(/of 5 events/)).not.toBeInTheDocument();
});
