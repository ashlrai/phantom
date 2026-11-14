/**
 * red-desk-fix-c192 — regression pin for the RQ-PHX-RECUTDESKOLDC190 rework.
 *
 * The PR's CI red was not a render bug: Quick typecheck failed on (a) stale
 * generated docs — the PR edited docs/QUEUE-STATS.md without regenerating
 * docs/llms.txt — and (b) Tier-1 closure drift — GET /api/queue/stats pulls
 * src/core/queue/{journal,stats}.ts into the authority import closure. This
 * test pins the user-visible contract that endpoint feeds: the Fleet
 * Dashboard station graph must request /api/queue/stats?window=<seconds> and
 * render the validated station view model.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from '../fleet-dashboard/QueueStationGraph.js';
import { evictAll } from '../../data/cache.js';

const NOW = 1_761_488_400_000;

function win(over: Record<string, unknown> = {}) {
  return {
    windowMs: 3_600_000,
    since: NOW - 3_600_000,
    until: NOW,
    arrivals: 4,
    departures: 4,
    lambda: 4 / 3600,
    mu: 8 / 3600,
    rho: 0.5,
    queueLength: 1,
    wait: 450,
    wip: 2,
    currentQueueLength: 1,
    currentWip: 2,
    littleLaw: { L: 2, W: 900, lambdaW: 1, drift: 0, flagged: false },
    ...over,
  };
}

const PAYLOAD = {
  schemaVersion: 1,
  generatedAt: NOW,
  units: { rates: 'per-second', durations: 'seconds' },
  stations: [
    { station: 'READY', windows: [win({ rho: 0.4, currentQueueLength: 1 })] },
    { station: 'pr-ci', windows: [win({ rho: 0.9, currentQueueLength: 5, littleLaw: { L: 4, W: 2, lambdaW: 0.2, drift: 0.8, flagged: true } })] },
    { station: 'merged', windows: [win({ rho: 0.2, currentQueueLength: 0 })] },
  ],
  pools: [],
};

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('red-desk-fix-c192: queue stats feed behind the station graph', () => {
  it('requests GET /api/queue/stats?window=3600 and renders the station graph', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(PAYLOAD), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<QueueStationGraph enabled windowSec={3600} />);

    expect(await screen.findByTestId('queue-bottleneck')).toBeTruthy();
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('pr-ci');
    expect(screen.getByTestId('station-pr-ci').getAttribute('data-band')).toBe('red');

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/queue/stats?window=3600'))).toBe(true);
  });
});
