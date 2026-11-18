import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { RuntimeIdentityBody } from './RuntimeIdentityCard.js';
import type { RuntimeIdentityView } from './runtime-identity-model.js';

const NOW = Date.parse('2026-11-14T19:32:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const view = (o: Partial<RuntimeIdentityView> = {}): RuntimeIdentityView => ({
  generatedAt: iso(-40_000), host: 'h1', platform: 'darwin', asOf: 'unknown', installedVersion: '1.2.0',
  sourceVersion: '1.2.0', versionDrift: false, tailnetName: 'h1.ts.net',
  fleetState: { ageSeconds: 60, stale: false }, reasons: [], ...o });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fresh reading shows the Read row and no badge', () => {
  render(<RuntimeIdentityBody view={view()} nowMs={NOW} />);
  expect(screen.getByText('Read')).toBeTruthy();
  expect(screen.getByText('40s ago')).toBeTruthy();
  expect(screen.queryByText('stale reading')).toBeNull();
});
it('a 120 s old reading gets the stale badge', () => {
  render(<RuntimeIdentityBody view={view({ generatedAt: iso(-120_000) })} nowMs={NOW} />);
  expect(screen.getByText('stale reading')).toBeTruthy();
});
it('malformed generatedAt reads unknown without crashing', () => {
  render(<RuntimeIdentityBody view={view({ generatedAt: 'nope' })} nowMs={NOW} />);
  expect(screen.getByText('unknown')).toBeTruthy();
  expect(screen.queryByText('stale reading')).toBeNull();
});
it('shows evidence age when asOf differs from generatedAt', () => {
  render(<RuntimeIdentityBody view={view({ asOf: iso(-300_000) })} nowMs={NOW} />);
  expect(screen.getByText(/evidence/)).toBeTruthy();
  expect(screen.getByText('5m ago')).toBeTruthy();
});
it('a generatedAt far in the future is flagged as clock skew', () => {
  render(<RuntimeIdentityBody view={view({ generatedAt: iso(120_000) })} nowMs={NOW} />);
  expect(screen.getByTitle('clock skew').textContent).toBe('stale reading');
});
it('null view keeps the existing text', () => {
  render(<RuntimeIdentityBody view={null} nowMs={NOW} />);
  expect(screen.getByText('Runtime identity not available on this build')).toBeTruthy();
});
