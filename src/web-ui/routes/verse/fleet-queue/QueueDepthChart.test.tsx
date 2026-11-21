import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { resetLaneFocus, takeRequestedLane } from '../fleet-lanes/lane-focus-request.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { dropJobsQuery } from './drop-job-queries.js';
import { QueueDepthChart } from './QueueDepthChart.js';
import { laneHoldsQuery } from './queue-holds-model.js';
import { QueuePane } from './QueuePane.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 77, ready: 77, parked: 0, malformed: 0, skipsLast24h: 0,
  byLane: [
    { lane: 'stranger', ready: 0, parked: 0 }, { lane: 'thin', ready: 2, parked: 0 }, { lane: 'held', ready: 5, parked: 0 },
    { lane: 'zero', ready: 0, parked: 0 }, { lane: 'fine', ready: 20, parked: 0 }, { lane: 'deep', ready: 50, parked: 0 },
  ],
  groups: [], skips: [],
};
const lane = (name: string, target: number, held = false) => ({ lane: name, running: 0, target, held });
const snapshot = { lanes: [lane('deep', 10), lane('fine', 10), lane('thin', 10), lane('held', 10, true), lane('zero', 0)] };

beforeEach(() => {
  evictAll();
  resetLaneFocus();
  vi.spyOn(opsQueueQuery, 'fetch').mockResolvedValue(queue);
  vi.spyOn(laneHoldsQuery, 'fetch').mockResolvedValue(null);
  vi.spyOn(dropJobsQuery, 'fetch').mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const chart = () => screen.findByRole('region', { name: 'Depth by lane' });
const draw = (onOpenLane = vi.fn()) => { render(<QueueDepthChart visible onOpenLane={onOpenLane} />); return onOpenLane; };

it('draws each lane against its live slots, deepest first, with the words beside the bar', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  draw();
  const region = within(await chart());
  const deep = await region.findByRole('button', { name: 'Open deep in Lanes: 50 ready, 5x its 10 live slots · over 3x' });
  expect(deep).toHaveTextContent('deep50 ready · 5x its 10 live slots · over 3x');
  const items = region.getAllByRole('listitem');
  expect(items.map(item => item.textContent?.split(/\d/)[0])).toEqual(['deep', 'fine', 'thin', 'held', 'zero', 'stranger']);
  expect(items[0]).toHaveAttribute('data-bounds', 'over');
  expect(items[0]).toHaveAttribute('data-over', 'true');
  expect(items[1]).toHaveAttribute('data-bounds', 'in');
  expect(items[1]).not.toHaveAttribute('data-over');
  expect(items[2]).toHaveAttribute('data-bounds', 'under');
  expect(region.getByRole('button', { name: 'Open fine in Lanes: 20 ready, 2x its 10 live slots · in bounds' })).toBeInTheDocument();
});

it('never passes a held, zero-target or unread lane off as an empty queue', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  draw();
  const region = within(await chart());
  const held = (await region.findByRole('button', { name: 'Open held in Lanes: 5 ready, held, so its slots drain nothing' })).closest('li')!;
  expect(held).toHaveAttribute('data-state', 'held');
  expect(held).not.toHaveAttribute('data-bounds');
  expect(region.getByRole('button', { name: 'Open zero in Lanes: 0 ready, no live slots: its target is 0' }).closest('li')).toHaveAttribute('data-state', 'no-slots');
  expect(region.getByRole('button', { name: 'Open stranger in Lanes: 0 ready, live slots unknown' }).closest('li')).toHaveAttribute('data-state', 'unknown');
});

it('leads with the whole queue, counting only lanes that are not held', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  draw();
  const whole = (await within(await chart()).findByText('77 ready · 2.6x their 30 live slots · in bounds')).parentElement!;
  expect(whole).toHaveTextContent(/^All lanes/);
  expect(whole).toHaveAttribute('data-bounds', 'in');
  expect(whole.tagName).toBe('DIV');
});

it('reads every bar as unknown when the lane read fails', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockRejectedValue(new Error('offline'));
  draw();
  const region = within(await chart());
  expect((await region.findByText('77 ready · live slots unknown')).parentElement).toHaveAttribute('data-state', 'unknown');
  for (const item of region.getAllByRole('listitem')) expect(item).toHaveAttribute('data-state', 'unknown');
  expect(region.queryByText(/could not refresh/)).toBeNull();
});

it('stays out of the way until the queue has lanes to draw', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  vi.spyOn(opsQueueQuery, 'fetch').mockResolvedValue({ ...queue, byLane: [] });
  render(<QueuePane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('No lane counts available.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Depth by lane' })).toBeNull();
});

it('draws nothing on a build without the queue', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  vi.spyOn(opsQueueQuery, 'fetch').mockResolvedValue(null);
  render(<QueuePane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('Queue not in this build')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Depth by lane' })).toBeNull();
});

it('opens the selected lane in Lanes from the Queue pane, above the queue itself', async () => {
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(snapshot);
  const openPane = vi.fn();
  render(<QueuePane {...{ visible: true, host: { openPane } } as unknown as PaneProps} />);
  const region = await chart();
  expect(region.compareDocumentPosition(await screen.findByRole('region', { name: 'Queue' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(await within(region).findByRole('button', { name: /^Open deep in Lanes/ }));
  expect(openPane).toHaveBeenCalledWith('fleet-lanes');
  expect(takeRequestedLane()).toBe('deep');
});
