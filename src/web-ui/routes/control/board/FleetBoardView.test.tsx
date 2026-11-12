import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FleetBoardView } from './FleetBoardView.js';
import { evictAll } from '../../../data/cache.js';
import type { FleetBoardResponse } from '../../../data/api-types.js';

const BOARD: FleetBoardResponse['board'] & object = {
  schema: 'fleet.leader-board.v1',
  generatedAt: '2026-11-07T12:00:00.000Z',
  lanes: [
    { lane: 'claude', ready: 4, parked: 1, running: 2, mergesLastHour: 3, oldestWaitSeconds: 540 },
    { lane: 'devin', ready: 0, parked: 0, running: 1, mergesLastHour: null, oldestWaitSeconds: null },
  ],
  queueDepthByTier: { frontier: 2, work: 5, mid: 1 },
  mergesLastHour: 7,
  conflictingPrs: {
    count: 2,
    delta: 1,
    trend: 'rising',
    history: [
      { at: '2026-11-07T11:00:00.000Z', count: 1 },
      { at: '2026-11-07T12:00:00.000Z', count: 2 },
    ],
  },
  needsMason: { status: 'available', count: 1, items: [{ id: 'nm-abc123def456', text: 'approve the domain renewal' }] },
  sources: { readyTsv: 'healthy', queueCounts: 'ok', needsMason: 'available' },
};

function envelope(partial: Partial<FleetBoardResponse> = {}): FleetBoardResponse {
  return { schema: 'fleet.leader-board.v1', status: 'ok', ageSeconds: 150, board: BOARD, ...partial };
}

function mockFetch(body: FleetBoardResponse | string, status = 200) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

describe('FleetBoardView', () => {
  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders lanes, tier depth, merge rate, the conflict trend and needs-Mason items', async () => {
    vi.stubGlobal('fetch', mockFetch(envelope()));
    render(<FleetBoardView />);

    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    expect(screen.getByText('devin')).toBeInTheDocument();
    // Tier chips.
    expect(screen.getByText('frontier')).toBeInTheDocument();
    expect(screen.getByText('work')).toBeInTheDocument();
    // Queue depth tile: 2+5+1 = 8 READY.
    expect(screen.getByText('Queue depth')).toBeInTheDocument();
    expect(screen.getAllByText('8').length).toBeGreaterThanOrEqual(1);
    // Merge rate tile.
    expect(screen.getByText('Merges · last hour')).toBeInTheDocument();
    expect(screen.getByText('unique merges, all lanes')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    // Conflicting-PR trend: count in the tile, trend described in the caption.
    expect(screen.getByText('Conflicting PRs')).toBeInTheDocument();
    expect(screen.getByText('rising across recorded ticks')).toBeInTheDocument();
    // Needs Mason.
    expect(screen.getByText('approve the domain renewal')).toBeInTheDocument();
    expect(screen.getByText('nm-abc123def456')).toBeInTheDocument();
    // Source honesty footer.
    expect(screen.getByText(/ready\.tsv healthy · queue counts ok · needs-mason available/)).toBeInTheDocument();
  });

  it('prints unknown for measurements the tick could not make — never a zero', async () => {
    vi.stubGlobal('fetch', mockFetch(envelope()));
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByText('devin')).toBeInTheDocument());
    // devin's mergesLastHour and oldestWaitSeconds are null.
    const unknowns = screen.getAllByText('unknown');
    expect(unknowns.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the designed empty state when no tick has recorded a board', async () => {
    vi.stubGlobal('fetch', mockFetch(envelope({ status: 'missing', board: null, ageSeconds: null })));
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByText('No Leader board yet')).toBeInTheDocument());
    expect(screen.queryByText('Lanes')).not.toBeInTheDocument();
  });

  it('reports an unreadable recording instead of an empty board', async () => {
    vi.stubGlobal('fetch', mockFetch(envelope({ status: 'unavailable', board: null, ageSeconds: null })));
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unreadable/));
  });

  it('shows the inline error when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    render(<FleetBoardView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
