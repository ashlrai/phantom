import { afterEach, describe, expect, it, vi } from 'vitest';
import { busLiteQuery, narrowBusLite, resetBusMissingForTest } from './bus-query.js';
import { json } from './mobile.test-support.js';

function fixture() {
  return {
    v: 1,
    hops: [{ inputTokens: 100, outputTokens: 20 }, { inputTokens: 50, outputTokens: null }],
    events: [
      { at: '2026-10-31T10:00:00Z', kind: 'launch', text: 'Started' },
      { at: '2026-10-31T11:00:00Z', kind: 'inbox', text: 'Please check' },
    ],
    sources: { hops: 'healthy', events: 'degraded' },
  };
}

afterEach(() => { resetBusMissingForTest(); vi.unstubAllGlobals(); });

describe('narrowBusLite', () => {
  it('sums known hop tokens and puts newest events first', () => {
    expect(narrowBusLite(fixture())).toEqual({
      hops: 2, inputTokens: 150, outputTokens: null,
      events: [fixture().events[1], fixture().events[0]],
      sources: { hops: 'healthy', events: 'degraded' },
    });
  });

  it('rejects a wrong version, malformed events, timestamps, tokens and sources', () => {
    for (const raw of [
      { ...fixture(), v: 2 },
      { ...fixture(), events: {} },
      { ...fixture(), events: [{ at: 'bad', kind: 'launch', text: 'Started' }] },
      { ...fixture(), hops: [{ inputTokens: -1, outputTokens: 0 }] },
      { ...fixture(), sources: { hops: 'unknown', events: 'healthy' } },
    ]) expect(narrowBusLite(raw)).toBeNull();
  });

  it('keeps only the latest 50 events', () => {
    const events = Array.from({ length: 55 }, (_, i) => ({ at: new Date(i * 1000).toISOString(), kind: 'launch', text: String(i) }));
    const data = narrowBusLite({ ...fixture(), events });
    expect(data?.events).toHaveLength(50);
    expect(data?.events[0].text).toBe('54');
    expect(data?.events[49].text).toBe('5');
  });
});

describe('busLiteQuery', () => {
  it('remembers a 404 for the page lifetime', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => json({}, 404));
    vi.stubGlobal('fetch', fetch);
    await expect(busLiteQuery.fetch()).resolves.toBeNull();
    await expect(busLiteQuery.fetch()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/verse/fleet/live/bus?limit=50');
  });

  it('reports malformed responses as errors, not missing routes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ v: 2 })));
    await expect(busLiteQuery.fetch()).rejects.toMatchObject({ status: 502 });
  });
});
