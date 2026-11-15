import { describe, expect, it } from 'vitest';
import { unreadCounts, unreadLabel } from './unread-counts.js';

const seen = { leader: 1000, feed: 1000 };
const line = (at: number, who: 'mason' | 'leader' = 'leader', source = 'desktop') => ({ at, who, source });
const item = (ms: number) => ({ at: new Date(ms).toISOString() });

describe('unreadCounts', () => {
  it('counts Leader lines newer than seen, never Mason lines or system notes', () => {
    const leaderLines = [line(2000), line(3000, 'mason'), line(4000, 'leader', 'system'), line(5000)];
    expect(unreadCounts({ leaderLines, feedItems: [], seen }).leader).toBe(2);
  });

  it('does not count a line or item at exactly the seen time', () => {
    expect(unreadCounts({ leaderLines: [line(1000)], feedItems: [item(1000), item(1001)], seen })).toEqual({ leader: 0, feed: 1 });
  });

  it('counts leader and feed against their own seen times', () => {
    const counts = unreadCounts({ leaderLines: [line(1500)], feedItems: [item(1500)], seen: { leader: 2000, feed: 1000 } });
    expect(counts).toEqual({ leader: 0, feed: 1 });
  });

  it('ignores feed items whose time does not parse', () => {
    expect(unreadCounts({ leaderLines: [], feedItems: [{ at: 'nope' }], seen }).feed).toBe(0);
  });
});

describe('unreadLabel', () => {
  it('shows 99+ past the cap', () => {
    const feedItems = Array.from({ length: 150 }, (_, i) => item(2000 + i));
    const { feed } = unreadCounts({ leaderLines: [], feedItems, seen });
    expect(feed).toBe(150);
    expect(unreadLabel(feed)).toBe('99+');
    expect(unreadLabel(99)).toBe('99');
    expect(unreadLabel(3)).toBe('3');
  });
});
