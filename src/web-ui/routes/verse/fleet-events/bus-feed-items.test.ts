import { describe, expect, it } from 'vitest';
import { busFeedItems, mergeFeeds } from './bus-feed-items.js';
import type { FeedItem } from './fleet-events-model.js';

const receipt = (id: string, body: unknown, priority = 'P1') => ({
  cursor: 1, receivedAt: 1_767_225_600_000,
  envelope: { id, from: 'alpha', to: 'beta', priority, ttl: 5000, body },
});
const page = (messages: unknown[], timestamp?: unknown) => ({ v: 1, status: 'ok', messages, nextCursor: 1, timestamp });

describe('bus feed items', () => {
  it('maps interjections, kind fallback and bounded JSON excerpts', () => {
    const items = busFeedItems(page([
      receipt('one', { kind: 'interjection', channel: 'team', text: 'hello team', receivedAt: '2026-01-03T00:00:00Z' }),
      receipt('two', { kind: 'notice' }, 'P2'),
      receipt('three', { value: 'x'.repeat(150) }),
    ], '2026-01-02T00:00:00Z'));
    expect(items[0]).toEqual({ id: 'bus:one', kind: 'bus', at: '2026-01-03T00:00:00Z', text: 'alpha -> beta [P1] hello team', url: null });
    expect(items[1]).toEqual({ id: 'bus:two', kind: 'bus', at: '2026-01-02T00:00:00Z', text: 'alpha -> beta [P2] notice', url: null });
    expect(items[2]?.text).toBe(`alpha -> beta [P1] ${JSON.stringify({ value: 'x'.repeat(150) }).slice(0, 120)}`);
    expect(busFeedItems(page([receipt('four', { receivedAt: 'not-iso', text: 'hi' })]))[0]?.at).toBe('');
  });

  it('rejects unrecognized and malformed pages', () => {
    expect(busFeedItems(null)).toEqual([]);
    expect(busFeedItems({ messages: [] })).toEqual([]);
    expect(busFeedItems(page([receipt('bad', {}, 'urgent')]))).toEqual([]);
    expect(busFeedItems(page([{ envelope: {} }]))).toEqual([]);
  });

  it('merges newest first and leaves undated items last', () => {
    const item = (id: string, at: string): FeedItem => ({ id, at, kind: 'test', text: id, url: null });
    expect(mergeFeeds([item('older', '2026-01-01T00:00:00Z'), item('missing', '')],
      [item('newer', '2026-01-03T00:00:00Z'), item('middle', '2026-01-02T00:00:00Z')]).map(row => row.id))
      .toEqual(['newer', 'middle', 'older', 'missing']);
  });
});
