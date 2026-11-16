import { describe, expect, it } from 'vitest';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { needsYouItems } from '../command/fixtures.test-support.js';
import { groupMergeBursts } from './feed-merge-burst.js';
import { buildFeed, type FeedItem } from './feed-model.js';
import { countNew } from './feed-seen-store.js';

const merge = (n: number, hour = '10'): FeedItem => ({
  id: `merge:repo#${n}`, kind: 'merge', at: `2026-11-04T${hour}:${String(n).padStart(2, '0')}:00.000Z`,
  title: `Title ${n}`, body: `repo #${n}`, href: `https://example.com/${n}`,
});

describe('groupMergeBursts', () => {
  it('leaves small buckets unchanged and groups larger ones newest first', () => {
    const two = [merge(1), merge(2)];
    expect(groupMergeBursts(two)).toEqual(two);
    const result = groupMergeBursts(Array.from({ length: 7 }, (_, i) => merge(i + 1)));
    expect(result).toEqual([{ id: 'merge-hour:2026-11-04T10', kind: 'merge', at: merge(7).at,
      title: '7 PRs merged', body: 'Title 7 (repo #7)\nTitle 6 (repo #6)\nTitle 5 (repo #5)\nTitle 4 (repo #4)\nTitle 3 (repo #3)\nand 2 more', pane: 'fleet-merges' }]);
    expect(groupMergeBursts(two, { minGroup: 2 })).toHaveLength(1);
  });

  it('separates hours and preserves other items and their order', () => {
    const leader: FeedItem = { id: 'l', kind: 'leader', title: 'Leader', at: merge(1).at };
    const alert: FeedItem = { id: 'a', kind: 'alert', title: 'Alert', at: merge(1).at };
    const result = groupMergeBursts([leader, ...[1, 2, 3].map(n => merge(n)), alert, ...[1, 2, 3].map(n => merge(n, '11'))]);
    expect(result.map(item => item.id)).toEqual(['l', 'merge-hour:2026-11-04T10', 'a', 'merge-hour:2026-11-04T11']);
    expect(result[0]).toBe(leader);
    expect(result[2]).toBe(alert);
  });

  it('keeps the hour id and counts only one unseen item when a merge arrives', () => {
    const before = groupMergeBursts([merge(1), merge(2), merge(3)]);
    const after = groupMergeBursts([merge(1), merge(2), merge(3), merge(4)]);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(countNew(after, merge(3).at)).toBe(1);
  });

  it('groups before the feed limit so older Leader messages and alerts survive', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const items = Array.from({ length: 150 }, (_, i) => ({ repo: 'ashlrai/phantom', number: i + 1, title: `PR ${i + 1}`, mergedAt: new Date(now - 60_000 - i * 1000).toISOString() }));
    const feed = buildFeed({ runs: { mergesLastHour: { count: items.length, items } },
      leader: [msg({ id: 'old', at: '2026-11-04T10:00:00Z', text: 'Hello' })], needsYou: needsYouItems(now).slice(0, 1) });
    expect(feed.map(item => item.kind)).toEqual(expect.arrayContaining(['merge', 'leader', 'alert']));
    expect(feed.filter(item => item.kind === 'merge')).toHaveLength(1);
    expect(feed.find(item => item.kind === 'merge')?.title).toBe('150 PRs merged');
  });
});
