import { describe, expect, it } from 'vitest';
import type { OwnerThreadLine } from '../leader-thread/owner-thread-queries.js';
import { buildFeed, filterFeed, ownerAdapter } from './feed-model.js';

const row = (over: Partial<OwnerThreadLine>): OwnerThreadLine => ({
  seq: 1, id: 'o1', channel: 'telegram', senderId: '100000001', direction: 'inbound', at: '2026-11-09T10:00:00.000Z', text: 'Ship it.', ...over,
});

describe('ownerAdapter', () => {
  it('turns an inbound telegram row into an owner item labelled with its channel', () => {
    expect(ownerAdapter([row({})])).toEqual([{ id: 'owner:o1', at: '2026-11-09T10:00:00.000Z', kind: 'owner', title: 'Ship it.', label: 'Mason via Telegram' }]);
  });

  it('labels an outbound row with where the answer went', () => {
    const [item] = ownerAdapter([row({ direction: 'outbound', fanout: ['slack', 'desktop'] })]);
    expect(item?.label).toBe('Leader → Slack, Desktop');
  });

  it('falls back to the row channel when there is no fanout', () => {
    expect(ownerAdapter([row({ direction: 'outbound', channel: 'email' })])[0]?.label).toBe('Leader → Email');
  });

  it('drops inbound desktop rows but keeps outbound ones', () => {
    expect(ownerAdapter([row({ channel: 'desktop' })])).toEqual([]);
    expect(ownerAdapter([row({ channel: 'desktop', direction: 'outbound' })])).toHaveLength(1);
  });

  it('drops a row whose time does not parse', () => {
    expect(buildFeed({ owner: [row({ at: 'yesterday-ish' })] })).toEqual([]);
  });
});

describe('buildFeed with owner lines', () => {
  it('interleaves owner items by time with leader, merge and alert items', () => {
    const feed = buildFeed({
      leader: [{ id: 'l1', at: '2026-11-09T10:03:00.000Z', from: 'leader', text: 'Leader note' } as never],
      runs: { mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 7, title: 'Merged', mergedAt: '2026-11-09T10:01:00.000Z' }] } },
      needsYou: [{ id: 'n1', since: '2026-11-09T10:04:00.000Z', title: 'Alert', target: { kind: 'none' } } as never],
      owner: [row({ id: 'a', at: '2026-11-09T10:02:00.000Z' }), row({ id: 'b', at: '2026-11-09T10:05:00.000Z', text: 'Newest' })],
    });
    expect(feed.map(i => `${i.kind}:${i.title}`)).toEqual(['owner:Newest', 'alert:Alert', 'leader:Leader note', 'owner:Ship it.', 'merge:Merged']);
  });

  it('yields one item when the same row is given twice', () => {
    expect(buildFeed({ owner: [row({}), row({})] })).toHaveLength(1);
  });

  it('filters to owner items only', () => {
    const feed = buildFeed({ owner: [row({})], runs: { mergesLastHour: { count: 1, items: [{ repo: 'r/x', number: 1, title: 'M', mergedAt: '2026-11-09T10:01:00.000Z' }] } } });
    expect(filterFeed(feed, 'owner').map(i => i.kind)).toEqual(['owner']);
  });
});
