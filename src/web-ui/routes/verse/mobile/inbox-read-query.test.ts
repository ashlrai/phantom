/**
 * The phone's whole-inbox read (the route #1612 landed): FleetInboxReadV1 →
 * FleetInboxReadLite narrowing (unknown shapes are null, never a crash;
 * the wire's oldest-first order flips to newest-first), the 1..200 limit
 * clamp, and the not-in-this-build 404 memo — a missing route is asked
 * once per page lifetime, then answers null forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { evictAll } from '../../../data/cache.js';
import { INBOX_READ_LIMIT, INBOX_READ_LIMIT_MAX, inboxReadQuery, narrowInboxRead, resetInboxReadMissingForTest } from './inbox-read-query.js';
import { json, stubFetch } from './mobile.test-support.js';

function healthy(): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sourceState: 'healthy',
    limit: 50,
    source: null,
    dropped: 0,
    entries: [
      { at: '2026-10-31 10:00', source: 'Phantom desktop', priority: 'P0', text: 'older line' },
      { at: '2026-10-31 11:59', source: 'Telegram', priority: null, text: 'newest line' },
    ],
  };
}

afterEach(() => {
  evictAll();
  resetInboxReadMissingForTest();
  vi.unstubAllGlobals();
});

describe('narrowInboxRead', () => {
  it('accepts the documented payload, keeps only the screen’s fields, newest first', () => {
    const lite = narrowInboxRead(healthy());
    expect(lite).toMatchObject({
      generatedAt: '2026-10-31T12:00:00Z',
      sourceState: 'healthy',
      limit: 50,
      source: null,
      dropped: 0,
      entries: [
        { at: '2026-10-31 11:59', source: 'Telegram', priority: null, text: 'newest line' },
        { at: '2026-10-31 10:00', source: 'Phantom desktop', priority: 'P0', text: 'older line' },
      ],
    });
    expect(lite).not.toHaveProperty('v');
  });

  it('rejects non-objects, a wrong v, missing entries and bad entry shapes, never throws', () => {
    for (const bad of [
      null, undefined, 42, 'x', [],
      { ...healthy(), v: 2 },
      { ...healthy(), v: '1' },
      { generatedAt: '2026-10-31T12:00:00Z' },
      { ...healthy(), entries: 'nope' },
      { ...healthy(), entries: [{ at: 1, source: 's', priority: null, text: 't' }] },
      { ...healthy(), entries: [{ at: 'a', source: 's', text: 't' }] },
      { ...healthy(), entries: [{ at: 'a', source: 's', priority: 3, text: 't' }] },
      { ...healthy(), entries: [{ at: 'a', source: 's', priority: null }] },
      { ...healthy(), sourceState: 'unknown' },
      { ...healthy(), limit: 'all' },
      { ...healthy(), dropped: 'two' },
      { ...healthy(), source: 5 },
      { ...healthy(), generatedAt: null },
    ]) {
      expect(narrowInboxRead(bad)).toBeNull();
    }
  });

  it('accepts the other source states and a dropped count', () => {
    expect(narrowInboxRead({ ...healthy(), sourceState: 'degraded', dropped: 3, entries: [] }))
      .toMatchObject({ sourceState: 'degraded', dropped: 3, entries: [] });
    expect(narrowInboxRead({ ...healthy(), sourceState: 'missing' })).toMatchObject({ sourceState: 'missing' });
  });
});

describe('inboxReadQuery', () => {
  it('clamps the limit to 1..200 and keys per limit', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs/inbox': healthy() });
    await inboxReadQuery(0).fetch();
    await inboxReadQuery(9999).fetch();
    await inboxReadQuery(7).fetch();
    expect(stub.calls.map((c) => c.url)).toEqual([
      '/api/verse/fleet/runs/inbox?limit=1',
      '/api/verse/fleet/runs/inbox?limit=200',
      '/api/verse/fleet/runs/inbox?limit=7',
    ]);
    expect(inboxReadQuery(0).key).toBe('verse-mobile-inbox-read:1');
    expect(inboxReadQuery(500).key).toBe(`verse-mobile-inbox-read:${INBOX_READ_LIMIT_MAX}`);
    expect(inboxReadQuery().key).toBe(`verse-mobile-inbox-read:${INBOX_READ_LIMIT}`);
  });

  it('a 404 answers null once per page lifetime — the route is never re-asked', async () => {
    const stub = stubFetch({});
    await expect(inboxReadQuery().fetch()).resolves.toBeNull();
    await expect(inboxReadQuery().fetch()).resolves.toBeNull();
    await expect(inboxReadQuery(5).fetch()).resolves.toBeNull();
    expect(stub.calls.filter((c) => c.url.startsWith('/api/verse/fleet/runs/inbox'))).toHaveLength(1);
    resetInboxReadMissingForTest();
    await expect(inboxReadQuery().fetch()).resolves.toBeNull();
    expect(stub.calls.filter((c) => c.url.startsWith('/api/verse/fleet/runs/inbox'))).toHaveLength(2);
  });

  it('a shape it cannot read is an error, not a guessed render', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': { hello: 'world' } });
    await expect(inboxReadQuery().fetch()).rejects.toMatchObject({ detail: 'Unrecognized response — update Phantom.' });
  });

  it('other failures stay errors', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': json({ error: 'The inbox is rebuilding.' }, 500) });
    await expect(inboxReadQuery().fetch()).rejects.toBeInstanceOf(ApiError);
  });
});
