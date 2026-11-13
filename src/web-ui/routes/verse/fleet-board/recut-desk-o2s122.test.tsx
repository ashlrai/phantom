/**
 * recut-desk-o2s122.test.tsx — RQ-PHX-RECUTDESKO2S122 spec test for the
 * RQ-SWE3-BOARDUI-1 recut (Recut of PR #4084). Exercises the real entry
 * point: the 'fleet-board' pane registered through the verse pane registry,
 * and asserts the user-visible behavior the PR promised — the recorded
 * Leader board surfaced as lanes, queue depth and needs-Mason items, with
 * 'unknown' never collapsing to 0 and a missing recording a designed state.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { getPane } from '../panes/pane-registry.js';
import { FleetBoardPane } from './FleetBoardPane.js';
import './fleet-board.pane.js';
import type { FleetBoardResponse } from '../../../data/api-types.js';

const BOARD: FleetBoardResponse['board'] & object = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-09T12:00:00.000Z',
  lanes: [
    { lane: 'devin', ready: 3, parked: 1, running: 2, mergesLastHour: 4, oldestWaitSeconds: 540 },
    { lane: 'claude', ready: 0, parked: 0, running: 1, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 2, work: 5, mid: 1 },
  mergesLastHour: 7,
  conflictingPrs: {
    count: 2,
    delta: 1,
    trend: 'rising',
    history: [
      { at: '2026-11-09T11:00:00.000Z', count: 1 },
      { at: '2026-11-09T12:00:00.000Z', count: 2 },
    ],
  },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-fake0001', text: 'approve the staging deploy' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

const PROPS = { visible: true } as PaneProps;

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('registers the session-independent Board pane in the dock registry', () => {
  expect(getPane('fleet-board')).toMatchObject({
    id: 'fleet-board', title: 'Board', needsSession: false,
  });
});

it('fetches /api/fleet/board and renders lanes, depth and the needs-Mason item', async () => {
  const envelope: FleetBoardResponse = { schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 150, board: BOARD };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/fleet/board');
    return new Response(JSON.stringify(envelope), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<FleetBoardPane {...PROPS} />);

  await waitFor(() => expect(screen.getByText('devin')).toBeInTheDocument());
  expect(screen.getByText('Fleet Board')).toBeInTheDocument();
  expect(screen.getByText('claude')).toBeInTheDocument();
  expect(screen.getByText('Queue depth')).toBeInTheDocument();
  expect(screen.getByText('8')).toBeInTheDocument();
  expect(screen.getAllByText('Needs Mason').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('approve the staging deploy')).toBeInTheDocument();
  // A lane the tick could not measure prints 'unknown', never 0.
  expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('reports a missing recording as the designed empty state, not a zeroed board', async () => {
  const envelope: FleetBoardResponse = { schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200 })));
  render(<FleetBoardPane {...PROPS} />);

  await waitFor(() => expect(screen.getByText('No Leader board yet')).toBeInTheDocument());
  expect(screen.queryByText('Queue depth by tier')).not.toBeInTheDocument();
});
