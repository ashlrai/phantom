/**
 * FleetCards.machines.test.tsx — the Machines row in the lanes strip: who is
 * answering, version drift, peer states, and the unavailable fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { resetLaneHistory } from './lane-history-store.js';
import { LanesStrip } from './FleetCards.js';

const machines = {
  asOf: '2026-01-01T00:00:00.000Z',
  answering: { host: 'mac-a.example', installedVersion: '3.30.40', sourceVersion: '3.30.41', versionDrift: true, fleetStateAgeSeconds: 10, fleetStateStale: false },
  peers: [
    { name: 'mac-b.example', os: 'macOS', online: true, ageSeconds: 30 },
    { name: 'mac-c.example', os: 'linux', online: false, ageSeconds: 3600 },
    { name: 'mac-d.example', os: 'linux', online: null, ageSeconds: 'unknown' },
  ],
  reasons: [],
};

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); resetLaneHistory(); });

describe('LanesStrip machines row', () => {
  it('shows host, drift badge and peer states', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/fleet/machines': machines } });
    render(<LanesStrip live={fleetLive('live', now)} />);
    expect(await screen.findByText('answering: mac-a.example v3.30.40')).toBeTruthy();
    expect(screen.getByText(/version drift/)).toBeTruthy();
    expect(screen.getByText('mac-b.example')).toBeTruthy();
    expect(screen.getByText(/^online · last seen/)).toBeTruthy();
    expect(screen.getByText(/^offline · last seen/)).toBeTruthy();
    expect(screen.getByText('unknown · last seen unknown')).toBeTruthy();
  });

  it('shows "machines: unavailable" when the request fails', async () => {
    const now = Date.now();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/fleet/machines': () => new Response('{}', { status: 500 }) } });
    render(<LanesStrip live={fleetLive('live', now)} />);
    expect(await screen.findByText('machines: unavailable')).toBeTruthy();
  });
});
