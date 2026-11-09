import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { resetLaneHistory } from './lane-history-store.js';
import { STALE_STANDING_LANES } from './lane-runsdir-fallback.js';
import { LanesStrip } from './FleetCards.js';

function staleLive(now: number) {
  const live = fleetLive('live', now);
  live.lanes = [{ lane: 'local', slots: 0, busy: 0, capReason: STALE_STANDING_LANES }];
  return live;
}

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); resetLaneHistory(); });

describe('LanesStrip world fallback', () => {
  it('shows a fresh world lane when the runs read fails', async () => {
    const now = Date.now();
    const field = (value: number | string) => ({ value, source: 'sensor', observedAt: new Date(now - 60_000).toISOString(), freshness: 'fresh' });
    stubSurfaceFetch({ kind: 'live', now, routes: {
      '/api/verse/fleet/runs': null,
      '/api/verse/world': { sensors: { lanes: [{ lane: 'local', used: field(34), remaining: field(66), unit: field('percent') }] } },
    } });
    render(<LanesStrip live={staleLive(now)} />);
    const notes = screen.getByRole('list', { name: 'Why lanes are limited' });
    await waitFor(() => expect(notes).toHaveTextContent('Lane capacity from the world model'));
    expect(notes).toHaveTextContent('34% used, 66% left, from sensor');
    expect(notes).not.toHaveTextContent('unobserved');
  });

  it('retains the unobserved note when both reads fail', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/runs': null, '/api/verse/world': null } });
    render(<LanesStrip live={staleLive(now)} />);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Why lanes are limited' })).toHaveTextContent('Lane capacity is unobserved'));
  });
});
