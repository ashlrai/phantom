import { describe, expect, it } from 'vitest';
import { dismiss } from './feed-dismiss-store.js';
import type { FeedItem } from './feed-model.js';
import { unseenCount } from './feed-unseen-count.js';

const items: FeedItem[] = [
  { id: 'a', kind: 'alert', title: 'Alert', at: '2026-01-03T00:00:00Z' },
  { id: 'b', kind: 'leader', title: 'News', at: '2026-01-02T00:00:00Z' },
  { id: 'c', kind: 'leader', title: 'Old', at: '2026-01-01T00:00:00Z' },
];

describe('unseenCount', () => {
  it('uses the Feed seen boundary and dismissal fingerprints', () => {
    const seen = '2026-01-01T12:00:00Z';
    expect(unseenCount(items, seen, {})).toBe(2);
    const dismissed = dismiss({}, items[0]!);
    expect(unseenCount(items, seen, dismissed)).toBe(1);
    expect(unseenCount([{ ...items[0]!, title: 'Changed' }, ...items.slice(1)], seen, dismissed)).toBe(2);
    expect(unseenCount(items, null, {})).toBe(0);
  });
});
