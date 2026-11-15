import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { BridgeCheckCard } from './BridgeCheckCard.js';

const section = (extra: Record<string, unknown> = {}) => ({
  status: 'ok', source: 'fleet-runtime', asOf: '2026-11-15T12:00:00.000Z', ...extra,
});
const env = (check: unknown) => ({ v: 1, authority: 'none', check });
const ready = { verdict: 'READY', asOf: '2026-11-15T12:00:00.000Z', missing: [],
  runtime: section(), claims: section({ source: 'coordination-ledger' }), peers: section({ source: 'peer-ledger' }) };
const stub = (body: unknown, status = 200) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('fetches the bridge-check route and shows READY with one row per section', async () => {
  const fetch = stub(env(ready));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge: READY')).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/runtime-identity/bridge-check', expect.any(Object));
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('peer-ledger · as of 2026-11-15T12:00:00.000Z')).toBeTruthy();
});
it('shows BLOCKED with the reason', async () => {
  stub(env({ ...ready, verdict: 'BLOCKED', missing: ['claims'],
    claims: section({ status: 'unavailable', reason: 'claims-reader-failed' }) }));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge: BLOCKED (claims: claims-reader-failed)')).toBeTruthy();
});
it('malformed body is unknown, never READY', async () => {
  stub(env({ verdict: 'READY' }));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge: unknown (unexpected report shape)')).toBeTruthy();
  expect(screen.queryByText('Bridge: READY')).toBeNull();
});
it('network failure and 404 are not READY', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const first = render(<BridgeCheckCard visible />);
  expect(await screen.findByText('Bridge: unknown (read failed)')).toBeTruthy();
  first.unmount(); evictAll();
  stub({}, 404);
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('The bridge check API has not landed in this build yet.')).toBeTruthy();
});
it('refresh refetches', async () => {
  const fetch = stub(env(ready));
  render(<BridgeCheckCard visible />);
  await screen.findByText('Bridge: READY');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh bridge check' }));
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(1));
});
it('hidden card renders nothing and does not fetch', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { container } = render(<BridgeCheckCard visible={false} />);
  expect(container.innerHTML).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
