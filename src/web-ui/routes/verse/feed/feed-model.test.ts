import { describe, expect, it } from 'vitest';
import { needsYouItems } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { alertAdapter, buildFeed, FEED_LIMIT, filterFeed, fleetEventAdapter, leaderAdapter, mergeAdapter, outboxAdapter } from './feed-model.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const runs = {
  outbox: [{ at: at(5), text: 'Shipped the lane fix.' }],
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Feed pane', mergedAt: at(2) }] },
  events: [{ at: at(8), kind: 'pause', text: 'Lane codex-2 paused: disk low' }],
};

describe('feed adapters', () => {
  it('maps Leader messages and skips Mason\'s own lines', () => {
    const items = leaderAdapter([msg({ id: 'a', at: at(1), text: 'Memo ready.\nThree actions.' }), msg({ id: 'b', from: 'mason', text: 'ok' })]);
    expect(items).toEqual([{ id: 'leader:a', at: at(1), kind: 'leader', title: 'Memo ready.', body: 'Memo ready.\nThree actions.' }]);
  });

  it('maps outbox answers as Leader items', () => {
    expect(outboxAdapter(runs)).toEqual([{ id: expect.stringMatching(/^outbox:/), at: at(5), kind: 'leader', title: 'Shipped the lane fix.' }]);
    expect(outboxAdapter({ outbox: 'nope' })).toEqual([]);
  });

  it('maps Needs-you items with an https link only', () => {
    const [pr, veto] = alertAdapter(needsYouItems(NOW));
    expect(pr).toMatchObject({ id: 'alert:fleet:owner-lane-pr:ashlrai/ashlrcode#81', kind: 'alert', href: 'https://github.com/ashlrai/ashlrcode/pull/81', body: expect.stringContaining('ci.yml') });
    expect(veto!.href).toBeUndefined();
  });

  it('maps merges with the PR link', () => {
    expect(mergeAdapter(runs)).toEqual([{ id: 'merge:ashlrai/phantom#42', at: at(2), kind: 'merge', title: 'Feed pane', body: 'ashlrai/phantom #42', href: 'https://github.com/ashlrai/phantom/pull/42' }]);
  });

  it('maps fleet events and ignores malformed rows', () => {
    expect(fleetEventAdapter({ events: [...runs.events, { at: 3, text: 'x' }, null] })).toEqual([
      { id: expect.stringMatching(/^fleet:/), at: at(8), kind: 'fleet', title: 'Lane codex-2 paused: disk low' },
    ]);
  });
});

describe('buildFeed', () => {
  it('merges every source newest first', () => {
    const feed = buildFeed({ leader: [msg({ id: 'l', at: at(1), text: 'Hi' })], runs, needsYou: needsYouItems(NOW).slice(0, 2) });
    expect(feed.map(item => item.kind)).toEqual(['leader', 'merge', 'leader', 'fleet', 'alert', 'alert']);
    expect(feed.map(item => Date.parse(item.at))).toEqual([...feed.map(item => Date.parse(item.at))].sort((a, b) => b - a));
  });

  it('dedupes by id, keeping the newest copy', () => {
    const feed = buildFeed({ leader: [msg({ id: 'x', at: at(9), text: 'old' }), msg({ id: 'x', at: at(1), text: 'new' })] });
    expect(feed).toHaveLength(1);
    expect(feed[0]!.title).toBe('new');
  });

  it('drops items whose time does not parse and normalises the rest to ISO', () => {
    const feed = buildFeed({ leader: [msg({ id: 'bad', at: 'yesterday' }), msg({ id: 'ok', at: '2026-11-04T11:00:00+01:00' })] });
    expect(feed.map(item => item.id)).toEqual(['leader:ok']);
    expect(feed[0]!.at).toBe('2026-11-04T10:00:00.000Z');
  });

  it('caps the stream', () => {
    const many = Array.from({ length: FEED_LIMIT + 20 }, (_, i) => msg({ id: `m${i}`, at: at(i) }));
    const feed = buildFeed({ leader: many });
    expect(feed).toHaveLength(FEED_LIMIT);
    expect(feed[0]!.id).toBe('leader:m0');
  });

  it('filters by kind', () => {
    const feed = buildFeed({ runs, needsYou: needsYouItems(NOW).slice(0, 2) });
    expect(filterFeed(feed, 'merge').map(item => item.id)).toEqual(['merge:ashlrai/phantom#42']);
    expect(filterFeed(feed, 'alert')).toHaveLength(2);
    expect(filterFeed(feed, 'all')).toHaveLength(feed.length);
  });
});

it('includes the shared API stream in chronological order', () => {
  const items = buildFeed({ shared: { schema: 'phantom.feed.v1', sources: { merges: 'available', releases: 'unknown', incidents: 'unknown', leaderReplies: 'available' }, items: [{ kind: 'merge', at: '2026-01-01T00:00:00Z', text: 'Merged in phantom' }, { kind: 'leader-reply', at: '2026-01-02T00:00:00Z', text: 'Done' }] } });
  expect(items.map(item => item.title)).toEqual(['Done', 'Merged in phantom']);
});
