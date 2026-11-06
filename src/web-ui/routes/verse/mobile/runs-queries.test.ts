/**
 * The phone's live-runs queries: FleetRunsV1 → FleetRunsLite narrowing
 * (unknown shapes are null, never a crash), the not-in-this-build 404 memo
 * (a missing route is asked once, ever), and the inbox POST — including its
 * own refusal vocabulary (INBOX_REFUSED carries the reason in `reason`,
 * which the shared client does not read).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsQuery, FleetRunsInboxError, NOT_IN_THIS_BUILD, postFleetRunsInbox, readFleetRunsLite, resetFleetRunsMissingForTest } from './runs-queries.js';
import { json, stubFetch, TOKEN } from './mobile.test-support.js';

function healthy(): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { workers: 'healthy' },
    lastTick: '2026-10-31T11:58:00Z',
    paused: false,
    claudeLane: 'healthy',
    lanes: [{ lane: 'claude', running: 2, target: 2, queued: 1, held: false, heldReason: null }],
    workers: [{ job: 'phm improve binshield', repo: 'ashlrai/phantom', lane: 'claude', tier: 'elite', ageSeconds: 300 }],
    leaders: [{ label: 'opus-leader', ageSeconds: 600 }],
    mergesLastHour: { count: 3, items: [{ repo: 'ashlrai/phantom', number: 1520, title: 'Bridge notes' }] },
    codexPersonal: { usedPct: 62, resetsAt: '2026-10-31T14:00:00Z', asOf: '2026-10-31T12:00:00Z' },
    inbox: [
      { at: '2026-10-31T11:59:00Z', source: 'Phantom mobile', text: 'newest line' },
      { at: '2026-10-31T11:50:00Z', source: 'Phantom desktop', text: 'older line' },
    ],
    events: [{ at: '2026-10-31T11:59:00Z', kind: 'tick', text: 'done' }],
  };
}

afterEach(() => {
  evictAll();
  resetFleetRunsMissingForTest();
  vi.unstubAllGlobals();
});

describe('readFleetRunsLite', () => {
  it('accepts a healthy FleetRunsV1, keeps only the screen’s fields, inbox newest-last and capped at five', () => {
    const raw = healthy();
    raw['inbox'] = Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-31T12:0${6 - i}:00Z`, source: 's', text: `m${i}` }));
    const lite = readFleetRunsLite(raw);
    expect(lite).toMatchObject({ generatedAt: '2026-10-31T12:00:00Z', lastTick: '2026-10-31T11:58:00Z', paused: false, claudeLane: 'healthy', mergesLastHour: { count: 3 }, codexPersonal: { usedPct: 62 } });
    expect(lite?.inbox).toHaveLength(5);
    expect(lite?.inbox.map((m) => m.text)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
    expect(lite).not.toHaveProperty('sources');
    expect(lite).not.toHaveProperty('events');
    expect(lite).not.toHaveProperty('v');
  });

  it('keeps nulls — they are real unknowns, not zeros', () => {
    const raw = healthy();
    raw['mergesLastHour'] = { count: null, items: [] };
    raw['workers'] = [{ job: 'w', repo: 'r', lane: 'l', tier: 't', ageSeconds: null }];
    expect(readFleetRunsLite(raw)).toMatchObject({ mergesLastHour: { count: null }, workers: [{ ageSeconds: null }] });
  });

  it('rejects non-objects and any field off the contract, never throws', () => {
    for (const bad of [null, undefined, 42, 'x', [], { ...healthy(), v: 2 },
      { ...healthy(), lanes: 'nope' }, { ...healthy(), workers: [{}] },
      { ...healthy(), mergesLastHour: { count: 'x', items: [] } },
      { ...healthy(), codexPersonal: { usedPct: 'high' } },
      { ...healthy(), inbox: [{ at: 1 }] }]) {
      expect(readFleetRunsLite(bad)).toBeNull();
    }
  });
});

describe('fleetRunsQuery', () => {
  it('memoizes a 404 — a missing route is asked once, ever', async () => {
    const stub = stubFetch({});
    await expect(fleetRunsQuery.fetch()).rejects.toMatchObject({ status: 404 });
    await expect(fleetRunsQuery.fetch()).rejects.toBeInstanceOf(ApiError);
    expect(stub.calls.filter((c) => c.url.startsWith('/api/verse/fleet/runs'))).toHaveLength(1);
    resetFleetRunsMissingForTest();
    await expect(fleetRunsQuery.fetch()).rejects.toMatchObject({ status: 404 });
    expect(stub.calls.filter((c) => c.url.startsWith('/api/verse/fleet/runs'))).toHaveLength(2);
  });

  it('a shape it cannot read is an error, not a guessed render', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': { hello: 'world' } });
    await expect(fleetRunsQuery.fetch()).rejects.toMatchObject({ detail: 'Unrecognized response — update Phantom.' });
  });
});

describe('postFleetRunsInbox', () => {
  it('posts { text, source: Phantom mobile } with the mutation token', async () => {
    const stub = stubFetch({ 'POST /api/verse/fleet/runs/inbox': json({ ok: true, at: '2026-10-31T12:01:00Z' }, 201) });
    await expect(postFleetRunsInbox('ship binshield', TOKEN)).resolves.toEqual({ ok: true, at: '2026-10-31T12:01:00Z' });
    expect(stub.posts()[0]?.body).toEqual({ text: 'ship binshield', source: 'Phantom mobile' });
    expect(stub.posts()[0]?.headers['x-ashlr-token']).toBe(TOKEN);
  });

  it('a 422 INBOX_REFUSED throws the server’s own reason; 503/404 read as not-in-this-build', async () => {
    stubFetch({ 'POST /api/verse/fleet/runs/inbox': json({ code: 'INBOX_REFUSED', reason: 'Secret-shaped text is refused, not redacted.' }, 422) });
    const refused = await postFleetRunsInbox('sk-abc', TOKEN).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FleetRunsInboxError);
    expect((refused as Error).message).toBe('Secret-shaped text is refused, not redacted.');
    stubFetch({ 'POST /api/verse/fleet/runs/inbox': json({ code: 'INBOX_UNAVAILABLE' }, 503) });
    await expect(postFleetRunsInbox('hi', TOKEN)).rejects.toThrow(NOT_IN_THIS_BUILD);
    stubFetch({});
    await expect(postFleetRunsInbox('hi', TOKEN)).rejects.toThrow(NOT_IN_THIS_BUILD);
  });
});
