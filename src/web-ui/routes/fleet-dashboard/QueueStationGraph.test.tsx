/**
 * QueueStationGraph.test.tsx — the live station graph fed by
 * GET /api/queue/stats (same payload as `phm queue stats --json`).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueueStationGraph } from './QueueStationGraph.js';
import { evictAll } from '../../data/cache.js';

const NOW = 1_761_488_400_000;

function win(over: Record<string, unknown> = {}) {
  return {
    windowMs: 3_600_000,
    since: NOW - 3_600_000,
    until: NOW,
    arrivals: 6,
    departures: 6,
    lambda: 6 / 3600,
    mu: 10 / 3600,
    rho: 0.6,
    queueLength: 1.5,
    wait: 900,
    wip: 2.5,
    currentQueueLength: 2,
    currentWip: 3,
    littleLaw: { L: 2.5, W: 1500, lambdaW: 2.5, drift: 0, flagged: false },
    ...over,
  };
}

const PAYLOAD = {
  schemaVersion: 1,
  generatedAt: NOW,
  units: { rates: 'per-second', durations: 'seconds' },
  stations: [
    { station: 'planned', windows: [win({ rho: 0.4, currentQueueLength: 1 })] },
    { station: 'READY', windows: [win({ rho: 0.75, currentQueueLength: 3 })] },
    { station: 'pr-ci', windows: [win({ rho: 0.97, currentQueueLength: 9, littleLaw: { L: 3, W: 1, lambdaW: 0.1, drift: 0.9, flagged: true } })] },
    { station: 'merged', windows: [win({ rho: 0.2, arrivals: 2, currentQueueLength: 0 })] },
  ],
  pools: [{ pool: 'codex-personal', windows: [win({ rho: 0.8 })] }],
};

function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', mockFetch(PAYLOAD));
});
afterEach(() => vi.unstubAllGlobals());

describe('QueueStationGraph', () => {
  it('renders stations in pipeline order with rho bands and queue lengths', async () => {
    render(<QueueStationGraph />);
    const bottleneck = await screen.findByTestId('queue-bottleneck');
    expect(bottleneck.textContent).toBe('pr-ci');

    const ids = screen.getAllByTestId(/^station-/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['station-planned', 'station-READY', 'station-pr-ci', 'station-merged']);

    expect(screen.getByTestId('station-planned').getAttribute('data-band')).toBe('green');
    expect(screen.getByTestId('station-READY').getAttribute('data-band')).toBe('amber');
    expect(screen.getByTestId('station-pr-ci').getAttribute('data-band')).toBe('red');
    expect(screen.getByTestId('station-pr-ci').getAttribute('data-bottleneck')).toBe('true');
    expect(screen.getByTestId('station-merged').getAttribute('data-bottleneck')).toBe('false');

    // Queue length is the live "waiting now" count, not the window average.
    expect(screen.getByText('ρ 0.97 · q 9')).toBeTruthy();
    expect(screen.getByTestId('little-drift').textContent).toMatch(/PR CI/);
    expect(screen.getByTestId('queue-pools').textContent).toContain('codex-personal');
  });

  it('shows an inline error and keeps the panel chrome when the read fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'nope' }, 404));
    render(<QueueStationGraph />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Queue stats unavailable/);
    expect(screen.getByText('Queue stations')).toBeTruthy();
  });

  it('renders the empty state when no visits were recorded', async () => {
    vi.stubGlobal('fetch', mockFetch({ schemaVersion: 1, generatedAt: NOW, units: {}, stations: [], pools: [] }));
    render(<QueueStationGraph />);
    expect((await screen.findByText(/No queue visits recorded/)).textContent).toBeTruthy();
  });

  it('surfaces a malformed payload as an error rather than rendering it', async () => {
    vi.stubGlobal('fetch', mockFetch({ schemaVersion: 2, stations: 'nope' }));
    render(<QueueStationGraph />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/queue stats rejected/);
  });

  it('marks stations with no measured service as unknown and still finds the bottleneck', async () => {
    vi.stubGlobal('fetch', mockFetch({
      schemaVersion: 1,
      generatedAt: NOW,
      stations: [
        { station: 'claimed', windows: [win({ mu: null, rho: null, wait: null, departures: 0, currentQueueLength: 4 })] },
        { station: 'merged', windows: [win({ rho: 0.5, currentQueueLength: 1 })] },
      ],
      pools: [],
    }));
    render(<QueueStationGraph />);
    await waitFor(() => expect(screen.getByTestId('station-claimed').getAttribute('data-band')).toBe('unknown'));
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('claimed');
  });
});
