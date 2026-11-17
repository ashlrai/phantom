import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SurfaceOwnerBody, SurfaceOwnerCard } from './SurfaceOwnerCard.js';
import { parseSurfaceOwners } from './surface-owner-model.js';

const row = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, authority: 'none', surface: 'slack-bridge', asOf: '2026-11-13T12:00:00Z',
  owner: 'dot', ownerSource: 'advisory-claim', liveClaims: [{ id: 'c1', agent: 'dot', expiresInSeconds: 120 }],
  lastLanded: null, scannedPaths: [], reasons: [], ...extra,
});
const envelope = (surfaces: unknown[]) => ({ v: 1, authority: 'none', generatedAt: '2026-11-13T12:00:00Z', surfaces });
const body = (...surfaces: unknown[]) => render(<SurfaceOwnerBody rows={parseSurfaceOwners(envelope(surfaces))} />);
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows advisory ownership and the history caption', () => {
  body(row());
  expect(screen.getByText('slack-bridge')).toBeTruthy();
  expect(screen.getByText('dot (advisory claim, expires in 2m)')).toBeTruthy();
  expect(screen.getByText('Claims are advisory; landed history never makes an owner.')).toBeTruthy();
});
it('shows no owner beside landed history', () => {
  body(row({ owner: '', ownerSource: 'none', liveClaims: [],
    lastLanded: { jobId: 'J392', pr: 392, date: '2026-11-13', path: 'src/example.ts' } }));
  expect(screen.getByText('no live claim')).toBeTruthy();
  expect(screen.getByText('last landed J392 PR #392 2026-11-13')).toBeTruthy();
});
it('shows unknown evidence with the first reason', () => {
  body(row({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [], reasons: ['reader failed', 'second'] }));
  expect(screen.getByText('unknown: reader failed')).toBeTruthy();
  expect(screen.queryByText(/second/)).toBeNull();
});
it('drops malformed rows', () => {
  body(row(), row({ surface: 'bad-surface' }));
  expect(screen.queryByText('bad-surface')).toBeNull();
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
});
it('fetches the list route in the Owners landmark', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(envelope([row()])), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<SurfaceOwnerCard visible />);
  expect(screen.getByRole('region', { name: 'Owners' })).toBeTruthy();
  expect(await screen.findByText('dot (advisory claim, expires in 2m)')).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/runtime-identity/surface-owner', expect.any(Object));
});
it('404 shows not-landed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<SurfaceOwnerCard visible />);
  expect(await screen.findByText('The surface owner API has not landed in this build yet.')).toBeTruthy();
});
it('network failure shows unknown', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<SurfaceOwnerCard visible />);
  expect(await screen.findByText('Owners unknown: read failed')).toBeTruthy();
});
it('hidden cards do not fetch and show the loading state', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<SurfaceOwnerCard visible={false} />);
  expect(screen.getByRole('status').textContent).toBe('Reading owners…');
  expect(fetch).not.toHaveBeenCalled();
});
