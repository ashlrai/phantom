import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLaneStreak, laneStreaksQuery } from './lane-streak-query.js';

const lane = { lane: 'claude-api', launches: 3, ended: 3, empties: 3, published: 0, running: 0,
  medianMinutes: 10, verdict: 'burning', lastEmptyJob: 'RQ-PS10A103123Q8', lastEmptyAt: '2026-11-01T01:31:00Z' };
const data = { v: 1, generatedAt: '2026-11-01T01:32:00Z', source: 'ok', windowMinutes: 60, lanes: [lane] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

describe('lane streaks query', () => {
  it('accepts the pinned shape and requests the route without parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(data));
    vi.stubGlobal('fetch', fetchMock);
    expect(await laneStreaksQuery.fetch()).toEqual({ kind: 'available', data });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/verse/runs-history/lane-streaks');
  });
  it('rejects unsafe lane names and job IDs, dropping only invalid lanes', async () => {
    expect(isLaneStreak({ ...lane, lane: '../bad' })).toBe(false);
    expect(isLaneStreak({ ...lane, lastEmptyJob: '../bad' })).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...data, lanes: [lane, { ...lane, lane: '../bad' }, { ...lane, lastEmptyJob: '../bad' }] })));
    expect(await laneStreaksQuery.fetch()).toEqual({ kind: 'available', data });
  });
  it.each([
    ['404', () => json({ error: 'not found' }, 404)],
    ['other failure', () => json({}, 500)],
    ['non-200 success', () => json(data, 201)],
    ['non-JSON', () => new Response('not JSON')],
    ['malformed envelope', () => json({ ...data, windowMinutes: '60' })],
  ])('treats %s as no data', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    expect(await laneStreaksQuery.fetch()).toEqual({ kind: 'notInBuild' });
  });
  it('preserves cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(laneStreaksQuery.fetch(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
