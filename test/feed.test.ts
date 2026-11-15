import { describe, expect, it } from 'vitest';
import { orderFeed, type FeedItem } from '../src/core/feed.js';

describe('feed', () => {
  it('orders events from both sources before applying the limit', () => {
    const items: FeedItem[] = [
      { kind: 'merge', at: '2026-01-01T00:00:00Z', text: 'old' },
      { kind: 'leader-reply', at: '2026-01-03T00:00:00Z', text: 'new' },
      { kind: 'merge', at: '2026-01-02T00:00:00Z', text: 'middle' },
      { kind: 'leader-reply', at: '', text: 'unknown time' },
    ];
    expect(orderFeed(items, 2).map(item => item.text)).toEqual(['new', 'middle']);
  });
});
