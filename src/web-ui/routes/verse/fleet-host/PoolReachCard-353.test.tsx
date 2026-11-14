import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { PoolReachBody, PoolReachCard } from './PoolReachCard.js';
import { narrowPoolReach } from './pool-reach-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const FRESH = '2026-11-14T11:59:30Z';
const host = (slot: string, alias: string, online: unknown, extra: Record<string, unknown> = {}) =>
  ({ slot, alias, matched: true, online, lastSeen: FRESH, ageSeconds: 30, isSelf: false, ...extra });
const reach = (o: Record<string, unknown> = {}) => ({
  asOf: FRESH, self: 'mac-primary', role: 'primary',
  hosts: [host('primary', 'mac-primary', true, { isSelf: true }), host('backup', 'mac-backup', true)], reasons: [], ...o });
const body = (o?: Record<string, unknown>) => render(<PoolReachBody view={narrowPoolReach(reach(o))!} now={NOW} />);

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('both online renders a good summary and both rows', () => {
  body();
  const line = screen.getByText(/Primary and backup reachable/);
  expect(line.closest('p')?.getAttribute('data-tone')).toBe('good');
  expect(screen.getByText('primary mac-primary')).toBeTruthy();
  expect(screen.getByText('backup mac-backup')).toBeTruthy();
  expect(screen.getByText('this computer')).toBeTruthy();
  expect(screen.getAllByText('online')).toHaveLength(2);
});
it('backup offline renders a warn summary', () => {
  body({ hosts: [host('primary', 'mac-primary', true), host('backup', 'mac-backup', false, { ageSeconds: 7200 })], reasons: ['backup not in peer list'] });
  const line = screen.getByText(/Backup mac-backup not reachable: failover would fail/);
  expect(line.closest('p')?.getAttribute('data-tone')).toBe('warn');
  expect(screen.getByText('offline')).toBeTruthy();
  expect(screen.getByText('last seen 2h old')).toBeTruthy();
  expect(screen.getByText('backup not in peer list')).toBeTruthy();
});
it('reasons are capped at 5', () => {
  body({ hosts: [], reasons: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] });
  expect(screen.getByText('r5')).toBeTruthy();
  expect(screen.queryByText('r6')).toBeNull();
});
it('card has the Pool reach landmark and reads data from the route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ v: 1, generatedAt: FRESH, reach: reach({ asOf: new Date().toISOString() }) }), { status: 200, headers: { 'content-type': 'application/json' } })));
  render(<PoolReachCard visible />);
  expect(screen.getByRole('region', { name: 'Pool reach' })).toBeTruthy();
  expect(await screen.findByText(/Primary and backup reachable/)).toBeTruthy();
});
it('404 shows not-landed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<PoolReachCard visible />);
  expect(await screen.findByText('The pool reach API has not landed in this build yet.')).toBeTruthy();
});
it('network failure shows unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<PoolReachCard visible />);
  expect(await screen.findByText('Pool reach unavailable')).toBeTruthy();
});
