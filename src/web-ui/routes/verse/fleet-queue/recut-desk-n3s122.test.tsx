/**
 * RQ-PHX-RECUTDESKN3S122: recut of #4652 (live queue station graph,
 * RQ-QUEUE-5). Exercises the real mounted entry point `QueueStationGraph`
 * and asserts the user-visible graph it promised: every station labelled,
 * banded by rho, with the bottleneck called out — and hidden behind the
 * agentWorkspace flag otherwise.
 *
 * The component now reads the live GET /api/queue/stats feed (the #1048
 * recut, RQ-PHX-RECUTDESKOLDC190), so this suite feeds the same
 * estimateQueueStats payload `phm queue stats --json` prints.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from '../../fleet-dashboard/QueueStationGraph.js';
import { QUEUE_STATION_ORDER } from '../../../data/queue-stats/model.js';
import { evictAll } from '../../../data/cache.js';

const NOW = 1_761_488_400_000;

const win = (over: Record<string, unknown> = {}) => ({
  windowMs: 3_600_000,
  since: NOW - 3_600_000,
  until: NOW,
  arrivals: 6,
  departures: 6,
  lambda: 6 / 3600,
  mu: 10 / 3600,
  rho: 0.5,
  queueLength: 1.5,
  wait: 900,
  wip: 2.5,
  currentQueueLength: 2,
  currentWip: 3,
  littleLaw: { L: 2.5, W: 1500, lambdaW: 2.5, drift: 0, flagged: false },
  ...over,
});

/** Labels the view model gives the canonical ids (model.ts STATION_LABELS). */
const STATION_LABELS: Record<string, string> = {
  'pr-ci': 'PR CI',
  'merge-queue': 'merge queue',
};

const PAYLOAD = {
  schemaVersion: 1,
  generatedAt: NOW,
  units: { rates: 'per-second', durations: 'seconds' },
  stations: [
    ...QUEUE_STATION_ORDER.map((station) => ({
      station,
      windows: [win({ rho: station === 'pr-ci' ? 0.9 : 0.4 })],
    })),
    { station: 'build_farm', windows: [win({ rho: 0.3 })] },
    { station: 'review-bot', windows: [win({ rho: 0.2 })] },
  ],
  pools: [],
};

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('recut #4652: QueueStationGraph on the fleet dashboard', () => {
  it('renders all 11 labelled stations and names the bottleneck for the user', async () => {
    render(<QueueStationGraph enabled />);
    expect(await screen.findByText('Queue stations')).toBeTruthy();
    for (const id of QUEUE_STATION_ORDER) {
      expect(screen.getByTestId(`station-${id}`).textContent).toContain(STATION_LABELS[id] ?? id);
    }
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('pr-ci');
    expect(screen.getAllByTestId(/^station-/)).toHaveLength(11);
  });

  it('stays hidden when the agentWorkspace flag is off', () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<QueueStationGraph />);
    expect(container.innerHTML).toBe('');
  });
});
