import { afterEach, expect, it, vi } from 'vitest';
import { VERSE_FLEET_PEER_LEDGER_PATH } from '../../../../core/verse/fleet-peer-ledger-api.js';
import { evictAll } from '../../../data/cache.js';
import { parsePeerLedger } from './peer-ledger-model.js';
import { peerLedgerQuery } from './peer-ledger-query.js';

/** The server's real body: the bare report, no outer envelope. */
const serverBody = (over: Record<string, unknown> = {}) => ({
  v: 1, authority: 'none', status: 'ok', asOf: '2026-11-15T00:00:00Z', liveRows: 3, capacity: 1024,
  windowMs: 3600000, pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'alpha', target: 'beta', inWindow: 2, remaining: 4, lastAt: '2026-11-15T00:00:00Z' }],
  origins: [{ origin: 'thread-1', maxHop: 2, nearCap: false }],
  truncated: { pairs: false, origins: false },
  ...over,
});
const stub = (body: unknown, status = 200) => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

it('requests exactly the server-declared peer-ledger path', async () => {
  const fetch = stub(serverBody());
  await peerLedgerQuery.fetch(new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe(VERSE_FLEET_PEER_LEDGER_PATH);
});

it('parses the server envelope shape to a non-null view', async () => {
  stub(serverBody());
  const view = parsePeerLedger(await peerLedgerQuery.fetch(new AbortController().signal));
  expect(view?.status).toBe('ok');
  expect(view?.pairs).toHaveLength(1);
});

it('still rejects bodies without authority none or v 1', async () => {
  for (const bad of [{ authority: 'admin' }, { v: 2 }, { status: 'bogus' }]) {
    stub(serverBody(bad));
    expect(parsePeerLedger(await peerLedgerQuery.fetch(new AbortController().signal))).toBeNull();
  }
});

it('maps 404 to null', async () => {
  stub({}, 404);
  expect(await peerLedgerQuery.fetch(new AbortController().signal)).toBeNull();
});
