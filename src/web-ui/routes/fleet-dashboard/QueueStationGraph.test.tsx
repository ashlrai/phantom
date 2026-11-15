/**
 * QueueStationGraph.test.tsx — the live station graph fed by
 * GET /api/queue/stats (same payload as `phm queue stats --json`), gated by
 * the agentWorkspace flag. The queue-now / command source adapters from the
 * fixture generation are covered at the source level below.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueStationGraph } from './QueueStationGraph.js';
import { commandQueueStatsSource, queueNowQueueStatsSource } from '../../data/queue-stats/source.js';
import { QUEUE_NOW_FIXTURE } from '../../data/queue-stats/queue-now-fixture.js';
import { evictAll } from '../../data/cache.js';
import { AGENT_WORKSPACE_STORAGE_KEY } from '../../data/agent-workspace-flag.js';

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

function station(name: string, over: Record<string, unknown> = {}) {
  return { station: name, windows: [win(over)] };
}

/** The canonical pipeline plus two producer-defined stations (11 total). */
const ELEVEN_STATIONS = [
  station('planned', { rho: 0.3 }),
  station('READY', { rho: 0.5 }),
  station('claimed', { rho: 0.4 }),
  station('publish', { rho: 0.2 }),
  station('pr-ci', { rho: 0.8, currentQueueLength: 7 }),
  station('merge-queue', { rho: 0.1 }),
  station('merged', { rho: 0.2 }),
  station('released', { rho: 0.05 }),
  station('fix-main', { rho: 0.1 }),
  // Pending work but no measured service: 'unknown' band, and the model's
  // saturated rule makes it the bottleneck over every finite rho.
  station('build_farm', { mu: null, rho: null, wait: null, departures: 0, currentQueueLength: 4 }),
  station('review-bot', { rho: 0.3 }),
];

const NORMAL_PAYLOAD = {
  schemaVersion: 1,
  generatedAt: NOW,
  units: { rates: 'per-second', durations: 'seconds' },
  stations: ELEVEN_STATIONS,
  pools: [],
};

const OVERLOADED_PAYLOAD = {
  ...NORMAL_PAYLOAD,
  stations: [
    station('builder-run', { rho: 1.25, currentQueueLength: 18 }),
    station('merge-queue', { rho: 0.8 }),
    station('pr-ci', { rho: 0.97, currentQueueLength: 9, littleLaw: { L: 3, W: 1, lambdaW: 0.1, drift: 0.9, flagged: true } }),
  ],
};

function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
}

beforeEach(() => {
  evictAll();
  vi.stubGlobal('fetch', mockFetch(NORMAL_PAYLOAD));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(AGENT_WORKSPACE_STORAGE_KEY);
});

describe('QueueStationGraph', () => {
  it('renders nothing when the flag is off (default)', () => {
    const spy = mockFetch(NORMAL_PAYLOAD);
    vi.stubGlobal('fetch', spy);
    const { container } = render(<QueueStationGraph />);
    expect(container.innerHTML).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('renders all 11 reported stations in pipeline order when the flag is on', async () => {
    localStorage.setItem(AGENT_WORKSPACE_STORAGE_KEY, '1');
    render(<QueueStationGraph />);
    const node = await screen.findByTestId('station-pr-ci');
    expect(node.getAttribute('data-band')).toBe('amber');
    expect(node.getAttribute('data-bottleneck')).toBe('false');
    expect(screen.getByTestId('station-build_farm').getAttribute('data-band')).toBe('unknown');
    expect(screen.getByTestId('station-claimed').getAttribute('data-band')).toBe('green');
    expect(screen.getByTestId('queue-bottleneck').textContent).toBe('build_farm');
    expect(screen.queryByTestId('little-drift')).toBeNull();
    expect(screen.getAllByTestId(/^station-/)).toHaveLength(11);
    // Producer-defined stations sort after the canonical pipeline.
    const ids = screen.getAllByTestId(/^station-/).map((el) => el.getAttribute('data-testid'));
    expect(ids.indexOf('station-fix-main')).toBeLessThan(ids.indexOf('station-build_farm'));
  });

  it('renders the overloaded payload with drift flag', async () => {
    vi.stubGlobal('fetch', mockFetch(OVERLOADED_PAYLOAD));
    render(<QueueStationGraph enabled />);
    expect((await screen.findByTestId('queue-bottleneck')).textContent).toBe('builder-run');
    expect(screen.getByTestId('little-drift')).toBeTruthy();
    expect(screen.getByTestId('station-builder-run').getAttribute('data-band')).toBe('red');
    expect(screen.getByTestId('station-merge-queue').getAttribute('data-band')).toBe('amber');
    expect(screen.getByText('ρ 1.25 · q 18')).toBeTruthy();
  });

  it('renders the empty payload as an empty state', async () => {
    vi.stubGlobal('fetch', mockFetch({ schemaVersion: 1, generatedAt: NOW, units: {}, stations: [], pools: [] }));
    render(<QueueStationGraph enabled />);
    expect(await screen.findByText(/No queue visits recorded/)).toBeTruthy();
  });

  it('parses CI Efficiency queue-now.json through the queue-now adapter', async () => {
    const result = await queueNowQueueStatsSource(() => QUEUE_NOW_FIXTURE).load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.stations)).toHaveLength(11);
    expect(result.value.stations.merge_group?.rho).not.toBeNull();
    expect(result.value.little.drift).toBe(true);
    expect(JSON.stringify(result.value)).not.toMatch(/c_source|runner concurrency|emitters/);
  });

  it('reports the not-wired command stub as an error', async () => {
    const result = await commandQueueStatsSource().load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/RQ-QUEUE-3/);
  });

  it('never renders secrets smuggled into the payload', async () => {
    const leaky = {
      ...NORMAL_PAYLOAD,
      token: 'ghp_SECRETSECRET',
      stations: [
        ...NORMAL_PAYLOAD.stations,
        station('ghp_SECRETSECRET', { note: 'sk-live-SECRET' }),
        station('claimed', { rho: 0.4 }),
      ],
      pools: [{ pool: 'ghp_SECRETSECRET', windows: [win()], note: 'sk-live-SECRET' }],
    };
    vi.stubGlobal('fetch', mockFetch(leaky));
    const { container } = render(<QueueStationGraph enabled />);
    await screen.findByTestId('station-claimed');
    expect(container.innerHTML).not.toMatch(/SECRET|ghp_|sk-live/);
  });
});
