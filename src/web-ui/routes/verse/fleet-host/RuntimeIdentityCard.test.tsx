import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { RuntimeIdentityBody, RuntimeIdentityCard } from './RuntimeIdentityCard.js';
import type { RuntimeIdentityView } from './runtime-identity-model.js';
const view = (o: Partial<RuntimeIdentityView> = {}, fs: Partial<RuntimeIdentityView['fleetState']> = {}): RuntimeIdentityView => ({
  generatedAt: 'g', host: 'h1', platform: 'darwin', asOf: 'a', installedVersion: '1.2.0', sourceVersion: '1.2.0', versionDrift: false, tailnetName: 'h1.ts.net',
  fleetState: { ageSeconds: 180, stale: false, ...fs }, reasons: [], ...o });
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('shows drift badge only on drift', () => {
  const { rerender } = render(<RuntimeIdentityBody view={view()} />);
  expect(screen.queryByText('drift')).toBeNull();
  expect(screen.getByText('3m old', { exact: false })).toBeTruthy();
  rerender(<RuntimeIdentityBody view={view({ versionDrift: true })} />);
  expect(screen.getByText('drift')).toBeTruthy();
});
it('shows stale badge and unknown', () => {
  const { rerender } = render(<RuntimeIdentityBody view={view({}, { stale: true })} />);
  expect(screen.getByText('stale')).toBeTruthy();
  rerender(<RuntimeIdentityBody view={view({}, { stale: 'unknown', ageSeconds: 'unknown' })} />);
  expect(screen.queryByText('stale')).toBeNull();
  expect(screen.getByText('stale: unknown')).toBeTruthy();
});
it('renders reasons', () => {
  render(<RuntimeIdentityBody view={view({ reasons: ['tailscale missing'] })} />);
  expect(screen.getByText('tailscale missing')).toBeTruthy();
});
it('null view shows muted line', () => {
  render(<RuntimeIdentityBody view={null} />);
  expect(screen.getByText('Runtime identity not available on this build')).toBeTruthy();
});
it('404 shows the muted line', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<RuntimeIdentityCard visible />);
  expect(await screen.findByText('Runtime identity not available on this build')).toBeTruthy();
});
