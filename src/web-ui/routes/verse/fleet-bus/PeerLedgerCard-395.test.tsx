import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { PeerLedgerCard } from './PeerLedgerCard.js';

const envelope = () => ({
  v: 1, authority: 'none', generatedAt: '2026-11-15T00:00:00Z',
  report: {
    v: 1, authority: 'none', status: 'ok', asOf: '2026-11-15T00:00:00Z', liveRows: 12, capacity: 1024, windowMs: 3600000,
    pairLimit: 6, maxHops: 8,
    pairs: [
      { fromAgent: 'dot', target: 'claude', inWindow: 6, remaining: 0, lastAt: '2026-11-15T00:00:00Z' },
      { fromAgent: 'codex', target: 'devin', inWindow: 2, remaining: 4, lastAt: '2026-11-15T00:00:00Z' },
      { fromAgent: 'idle', target: 'quiet', inWindow: 0, remaining: 6, lastAt: '2026-11-15T00:00:00Z' },
    ],
    origins: [{ origin: 'thread-9', maxHop: 7, nearCap: true }, { origin: 'calm', maxHop: 1, nearCap: false }],
    truncated: { pairs: false, origins: false },
  },
});
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows a pair at limit and a near-cap origin', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(envelope().report), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<PeerLedgerCard visible />);
  expect(await screen.findByText('dot → claude')).toBeTruthy();
  expect(screen.getByText('0/6 left')).toBeTruthy();
  expect(screen.getByText('at limit')).toBeTruthy();
  expect(screen.getByText('codex → devin')).toBeTruthy();
  expect(screen.queryByText('idle → quiet')).toBeNull();
  expect(screen.getByText('thread-9')).toBeTruthy();
  expect(screen.getByText('hop 7/8')).toBeTruthy();
  expect(screen.queryByText('calm')).toBeNull();
  expect(screen.getByText('Peer bus: 12 of 1024 rows · 1 pair at limit · 1 thread near hop cap')).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/peer-ledger', expect.any(Object));
});
it('404 shows not-in-build', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<PeerLedgerCard visible />);
  expect(await screen.findByText('Peer bus budget is not in this build yet.')).toBeTruthy();
});
it('failure shows unknown', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  render(<PeerLedgerCard visible />);
  expect(await screen.findByText('Peer bus budget unknown: read failed')).toBeTruthy();
});
it('hidden card does not fetch', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<PeerLedgerCard visible={false} />);
  expect(screen.getByRole('status').textContent).toBe('Reading peer bus budget…');
  expect(fetch).not.toHaveBeenCalled();
});
