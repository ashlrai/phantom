/**
 * recut-desk-oldest-c216 — regression for the RQ-PHX-RECUTDESKOLDC216 recut of
 * stranded PR #4084 (RQ-SWE3-BOARDUI-1). Renders the restored FleetBoardView
 * against a stubbed GET /api/verse/fleet/board and asserts what the operator
 * sees: the board title, per-lane rows, tier-depth chips, the merge tile and
 * the needs-Mason list — plus the recorded-age freshness, the honesty fields
 * that make a recording different from a live gauge.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FleetBoardView } from '../control/board/FleetBoardView.js';
import { evictAll } from '../../data/cache.js';
import type { FleetBoardResponse } from '../../data/api-types.js';

const BOARD: FleetBoardResponse['board'] & object = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-07T12:00:00.000Z',
  lanes: [
    { lane: 'codex-personal', ready: 6, parked: 2, running: 32, mergesLastHour: 4, oldestWaitSeconds: 900 },
    { lane: 'devin', ready: 1, parked: 0, running: 3, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 3, work: 9, fast: 2 },
  mergesLastHour: 11,
  conflictingPrs: {
    count: 3,
    delta: -1,
    trend: 'falling',
    history: [
      { at: '2026-11-07T11:00:00.000Z', count: 4 },
      { at: '2026-11-07T12:00:00.000Z', count: 3 },
    ],
  },
  needsMason: { status: 'available', count: 2, items: [
    { id: 'nm-111111111111', text: 'approve the release signing' },
    { id: 'nm-222222222222', text: 'pay the domain invoice' },
  ] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('recut-desk-oldest-c216: FleetBoardView recut of PR #4084', () => {
  beforeEach(() => { evictAll(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the Leader board — title, lanes, tier depth, merges and needs-Mason', async () => {
    vi.stubGlobal('fetch', mockFetch({ schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 42, board: BOARD }));
    render(<FleetBoardView />);

    await waitFor(() => expect(screen.getByText('codex-personal')).toBeInTheDocument());
    // The page identity: a CONTROL board named Fleet Board, stamped as a
    // recording (ageSeconds 42 → "42s ago"), not a live gauge.
    expect(screen.getByText('Fleet Board')).toBeInTheDocument();
    expect(screen.getByText(/Recorded 42s ago/)).toBeInTheDocument();
    // Lanes render with their live counts.
    expect(screen.getByText('devin')).toBeInTheDocument();
    // Queue depth by tier chips — all three tiers named.
    expect(screen.getByText('frontier')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(screen.getByText('fast')).toBeInTheDocument();
    // Queue-depth tile totals 3+9+2 = 14 READY.
    expect(screen.getByText('Queue depth')).toBeInTheDocument();
    expect(screen.getAllByText('14').length).toBeGreaterThanOrEqual(1);
    // Merge-rate tile and both needs-Mason items are visible to the operator.
    expect(screen.getByText('Merges · last hour')).toBeInTheDocument();
    expect(screen.getByText('approve the release signing')).toBeInTheDocument();
    expect(screen.getByText('pay the domain invoice')).toBeInTheDocument();
  });

  it('honours the recorded-not-live contract: null measures print unknown, a missing board gets the empty state', async () => {
    vi.stubGlobal('fetch', mockFetch({ schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 42, board: BOARD }));
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByText('devin')).toBeInTheDocument());
    // devin's mergesLastHour and oldestWaitSeconds are null in the recording.
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2);
  });

  it('fetches exactly /api/verse/fleet/board — the recut route', async () => {
    const spy = mockFetch({ schema: 'fleet.leader-board.v1', status: 'missing', ageSeconds: null, board: null });
    vi.stubGlobal('fetch', spy);
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByText('No Leader board yet')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('/api/verse/fleet/board', expect.anything());
  });
});
