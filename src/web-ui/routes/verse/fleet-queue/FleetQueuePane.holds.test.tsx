import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { postReleaseHold } from '../fleet-lanes/lane-hold-release.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';
import { laneHoldsQuery } from './queue-holds-model.js';

vi.mock('../fleet-lanes/lane-hold-release.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../fleet-lanes/lane-hold-release.js')>(),
  postReleaseHold: vi.fn(),
}));

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T19:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 15, ready: 14, parked: 1, malformed: 0, skipsLast24h: 0,
  byLane: [{ lane: 'codex-personal', ready: 12, parked: 1 }, { lane: 'devin', ready: 2, parked: 0 }], groups: [], skips: [],
};
const holds: LaneTargetsV1 = {
  v: 1, generatedAt: '2026-10-31T19:00:00Z', sourceState: 'healthy', lanes: [
    { lane: 'codex-personal', target: 4, floor: 0, ceiling: 8, held: true, heldReason: 'autobackoff', heldUntil: '2026-10-31T21:00:00Z', lastChange: null, changedBy: null },
    { lane: 'devin', target: 4, floor: 0, ceiling: 8, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null },
  ],
};

beforeEach(() => {
  evictAll();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T19:00:00Z'));
  vi.spyOn(opsQueueQuery, 'fetch').mockResolvedValue(queue);
  vi.spyOn(fleetSupplyQuery, 'fetch').mockResolvedValue(null);
  vi.spyOn(laneHoldsQuery, 'fetch').mockResolvedValue(holds);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows held lanes and releases once, then refreshes both readings', async () => {
  let resolvePost!: (value: unknown) => void;
  vi.mocked(postReleaseHold).mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const button = await screen.findByRole('button', { name: 'Release hold on codex-personal' });
  const lane = button.closest('li')!;
  expect(within(lane).getByText('held: autobackoff · clears in 2 h 0 min')).toBeInTheDocument();
  expect(screen.getByText(/12 queued lines wait on held lanes/)).toBeInTheDocument();
  const unheld = screen.getByText('devin: 2 ready · 0 parked').closest('li')!;
  expect(within(unheld).queryByRole('button')).not.toBeInTheDocument();
  expect(within(unheld).queryByText(/held:/)).not.toBeInTheDocument();

  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(postReleaseHold).toHaveBeenCalledTimes(1);
  expect(postReleaseHold).toHaveBeenCalledWith('codex-personal', 'queue pane');
  vi.mocked(laneHoldsQuery.fetch).mockResolvedValue({ ...holds, lanes: holds.lanes.map((row) => ({ ...row, held: false })) });
  await act(async () => { resolvePost({}); });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Release hold on codex-personal' })).not.toBeInTheDocument());
  expect(screen.queryByText(/12 queued lines wait on held lanes/)).not.toBeInTheDocument();
  expect(laneHoldsQuery.fetch).toHaveBeenCalledTimes(2);
  expect(opsQueueQuery.fetch).toHaveBeenCalledTimes(2);
});

it('shows the release failure and permits a retry', async () => {
  vi.mocked(postReleaseHold).mockRejectedValueOnce(new Error('Release failed'));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const button = await screen.findByRole('button', { name: 'Release hold on codex-personal' });
  fireEvent.click(button);
  expect(await screen.findByText('Release failed')).toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(laneHoldsQuery.fetch).toHaveBeenCalledTimes(1);
  expect(opsQueueQuery.fetch).toHaveBeenCalledTimes(1);
});
