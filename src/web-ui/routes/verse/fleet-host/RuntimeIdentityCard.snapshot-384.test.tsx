import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { RuntimeIdentityCard } from './RuntimeIdentityCard.js';

const identityPayload = {
  v: 1, generatedAt: '2026-11-14T19:32:00Z',
  identity: {
    host: 'fake-host', platform: 'darwin', asOf: '2026-11-14T19:32:00Z',
    installedVersion: '3.30.34', sourceVersion: '3.30.34', versionDrift: false,
    tailnetName: 'fake-tailnet', fleetState: { ageSeconds: 60, stale: false }, reasons: [],
  },
};
const snapshotPayload = {
  v: 1, authority: 'none', generatedAt: '2026-11-14T19:32:00Z',
  snapshot: {
    host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '3.30.34',
    lastFleetStateRead: { mtime: '2026-11-14T19:30:00Z', ageSeconds: 120 },
    coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 120 },
    asOf: '2026-11-14T19:32:00Z', reasons: [],
  },
};

const stubFetch = (snapshot: () => Response) =>
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/api/verse/fleet/runtime-identity/snapshot')
      ? snapshot()
      : Response.json(identityPayload)));

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the coordination row from the snapshot route', async () => {
  stubFetch(() => Response.json(snapshotPayload));
  render(<RuntimeIdentityCard visible />);
  expect(await screen.findByText(/^fake-host \(darwin\)$/)).toBeTruthy();
  expect(await screen.findByText(/2 live claims · newest return 2m ago · tailnet fake-tailnet · as of \d{2}:\d{2}/)).toBeTruthy();
  expect(screen.getByText('Coordination')).toBeTruthy();
});

it('snapshot 404 shows the not-served line under the identity rows', async () => {
  stubFetch(() => new Response('{}', { status: 404 }));
  render(<RuntimeIdentityCard visible />);
  expect(await screen.findByText(/^fake-host \(darwin\)$/)).toBeTruthy();
  expect(await screen.findByText('Coordination: not served by this build')).toBeTruthy();
});
