import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { TailnetPeersBody, TailnetPeersCard } from './TailnetPeersCard.js';
import { narrowTailnetPeers, summarizePeers, type TailnetPeersView } from './tailnet-peers-model.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const payload = (o: Record<string, unknown> = {}) => ({
  asOf: '2026-11-14T11:57:00Z', self: 'fake-self-0',
  peers: [
    { name: 'fake-mini-1', os: 'macOS', online: true, lastSeen: '2026-11-14T11:59:48Z', ageSeconds: 12 },
    { name: 'fake-studio-2', os: 'macOS', online: false, lastSeen: '2026-11-14T10:00:00Z', ageSeconds: 7200 },
  ],
  reasons: [], ...o });

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('narrow round-trips a valid payload', () => {
  const v = narrowTailnetPeers(payload());
  expect(v).toMatchObject({ asOf: '2026-11-14T11:57:00Z', self: 'fake-self-0', dropped: 0, reasons: [] });
  expect(v?.peers[0]).toEqual({ name: 'fake-mini-1', os: 'macOS', online: true, lastSeen: '2026-11-14T11:59:48Z', ageSeconds: 12 });
  expect(v?.peers).toHaveLength(2);
});
it('narrow rejects non-objects', () => {
  for (const raw of [null, undefined, 'x', 3, []]) expect(narrowTailnetPeers(raw)).toBeNull();
});
it('narrow drops rows without a name and counts them', () => {
  const v = narrowTailnetPeers(payload({ peers: [{ os: 'linux', online: true }, 'junk', { name: 'fake-ok-3' }] }));
  expect(v?.peers.map((p) => p.name)).toEqual(['fake-ok-3']);
  expect(v?.dropped).toBe(2);
});
it('narrow coerces bad online and ageSeconds to unknown', () => {
  const v = narrowTailnetPeers(payload({ peers: [{ name: 'fake-a', online: 'yes', ageSeconds: -4 }, { name: 'fake-b', online: 1, ageSeconds: '5' }] }));
  expect(v?.peers.map((p) => [p.online, p.ageSeconds])).toEqual([['unknown', 'unknown'], ['unknown', 'unknown']]);
});
it('narrow caps rows at 64 and strings at 120 chars', () => {
  const peers = Array.from({ length: 70 }, (_, i) => ({ name: `fake-${i}`, online: true }));
  expect(narrowTailnetPeers(payload({ peers }))?.peers).toHaveLength(64);
  expect(narrowTailnetPeers(payload({ peers: [{ name: 'x'.repeat(500) }] }))?.peers[0]?.name).toHaveLength(120);
});
it('summarizePeers counts states', () => {
  const v = narrowTailnetPeers(payload({ peers: [
    { name: 'a', online: true }, { name: 'b', online: true }, { name: 'c', online: false }, { name: 'd', online: 'maybe' }] }));
  expect(summarizePeers(v as TailnetPeersView)).toEqual({ online: 2, offline: 1, unknown: 1 });
});
it('card body renders peers with labels and ages', () => {
  render(<TailnetPeersBody view={narrowTailnetPeers(payload())} now={NOW} />);
  expect(screen.getByText('Fleet computers')).toBeTruthy();
  expect(screen.getByText(/1 online · 1 offline/)).toBeTruthy();
  expect(screen.getByText('as of 3m old')).toBeTruthy();
  expect(screen.getByText('fake-mini-1')).toBeTruthy();
  expect(screen.getByText('fake-studio-2')).toBeTruthy();
  expect(screen.getByText('online')).toBeTruthy();
  expect(screen.getByText('offline')).toBeTruthy();
  expect(screen.getByText('last seen 0m old')).toBeTruthy();
  expect(screen.getByText('last seen 2h old')).toBeTruthy();
});
it('unknown state and age render as text', () => {
  render(<TailnetPeersBody view={narrowTailnetPeers(payload({ asOf: 'nope', peers: [{ name: 'fake-x', os: 'linux' }] }))} now={NOW} />);
  expect(screen.getByText('unknown')).toBeTruthy();
  expect(screen.getByText('last seen unknown')).toBeTruthy();
  expect(screen.getByText('as of unknown')).toBeTruthy();
});
it('empty peers shows the first reason', () => {
  render(<TailnetPeersBody view={narrowTailnetPeers(payload({ peers: [], reasons: ['tailscale not running', 'second'] }))} now={NOW} />);
  expect(screen.getByText('No tailnet peers visible')).toBeTruthy();
  expect(screen.getByText('tailscale not running')).toBeTruthy();
  expect(screen.queryByText('second')).toBeNull();
});
it('404 shows Peer list unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<TailnetPeersCard visible />);
  expect(await screen.findByText('Peer list unavailable')).toBeTruthy();
});
it('network failure shows Peer list unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<TailnetPeersCard visible />);
  expect(await screen.findByText('Peer list unavailable')).toBeTruthy();
});
