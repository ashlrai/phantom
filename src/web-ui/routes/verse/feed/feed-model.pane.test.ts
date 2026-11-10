import { describe, expect, it } from 'vitest';
import type { AgentBusPage } from '../fleet-bus/agent-bus-queries.js';
import type { UnifiedInboxEntry } from '../fleet-inbox/unified-inbox-model.js';
import { needsYouItems } from '../command/fixtures.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { buildFeed, feedItemPane, feedPaneLabel, type FeedItem } from './feed-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const runs = {
  outbox: [{ at: at(5), text: 'Shipped the lane fix.' }],
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Feed pane', mergedAt: at(2) }] },
  events: [{ at: at(8), kind: 'pause', text: 'Lane codex-2 paused: disk low' }],
};
const entry = (id: string, kind: UnifiedInboxEntry['kind']): UnifiedInboxEntry => ({
  id, source: 'imessage', kind, severity: 'info', blocking: false, title: `Fake ${id}`, since: at(3), expiresAt: null, act: [],
});
const bus = { messages: [{ cursor: 1, receivedAt: NOW - 60_000, envelope: { id: 'env-1', from: 'claude-1', to: 'leader', priority: 'P0', ttl: 1, body: { text: 'Main is red' } } }] } as unknown as AgentBusPage;

const feed = buildFeed({
  leader: [msg({ id: 'l1', at: at(1), text: 'Memo.' })],
  runs,
  needsYou: needsYouItems(NOW).slice(0, 2),
  owner: [{ seq: 1, id: 'o1', channel: 'telegram', senderId: '100000001', direction: 'inbound', at: at(4), text: 'Ship it.' }],
  update: [{ id: 'update-ready:9.9.9', category: 'action-required', severity: 'high', title: 'Update ready', detail: '', ts: at(6) }],
  bus,
  teammate: { total: 3, omitted: 0, sources: {}, items: [entry('dot', 'teammate-text'), entry('mail', 'gmail-over-target'), entry('li', 'linkedin-message')] },
  shared: { schema: 'phantom.feed.v1', sources: { merges: 'available', releases: 'unknown', incidents: 'unknown', leaderReplies: 'available' },
    items: [{ kind: 'merge', at: at(7), text: 'Merged in phantom' }, { kind: 'leader-reply', at: at(9), text: 'Done' }] },
});
const paneOf = (prefix: string) => feed.filter(item => item.id.startsWith(prefix)).map(item => item.pane);

describe('the pane that owns each Feed item', () => {
  it('sets the real pane id for every source', () => {
    expect(paneOf('leader:')).toEqual(['leader-thread']);
    expect(paneOf('outbox:')).toEqual(['leader-thread']);
    expect(paneOf('owner:')).toEqual(['leader-thread']);
    expect(paneOf('merge:')).toEqual(['fleet-merges']);
    expect(paneOf('fleet:')).toEqual(['fleet-events']);
    expect(paneOf('bus:')).toEqual(['fleet-bus']);
    expect(paneOf('teammate:')).toEqual(['fleet-inbox']);
    expect(paneOf('gmail:')).toEqual(['fleet-inbox']);
    expect(paneOf('linkedin:')).toEqual(['fleet-inbox']);
    expect(paneOf('shared:merge:')).toEqual(['fleet-merges']);
    expect(paneOf('shared:leader-reply:')).toEqual(['leader-thread']);
  });

  it('gives updates no pane and keeps the Needs-you https link with no pane', () => {
    expect(paneOf('update:')).toEqual([undefined]);
    const alerts = feed.filter(item => item.id.startsWith('alert:'));
    expect(alerts).toHaveLength(2);
    expect(alerts.every(item => item.pane === undefined && !('pane' in item))).toBe(true);
    expect(alerts.find(item => item.href)?.href).toBe('https://github.com/ashlrai/ashlrcode/pull/81');
  });

  it('labels every pane the Feed uses and nothing else', () => {
    const used = [...new Set(feed.map(item => item.pane).filter((pane): pane is NonNullable<FeedItem['pane']> => Boolean(pane)))].sort();
    expect(used).toEqual(['fleet-bus', 'fleet-events', 'fleet-inbox', 'fleet-merges', 'leader-thread']);
    expect(used.map(feedPaneLabel)).toEqual(['Open in Bus', 'Open in Events', 'Open in Inbox', 'Open in Merges', 'Open in Leader']);
    expect(feedPaneLabel('fleet-nowhere')).toBeUndefined();
    expect(feedPaneLabel('toString')).toBeUndefined();
    expect(feedPaneLabel(undefined)).toBeUndefined();
    expect(feedItemPane({ id: 'alert:x', kind: 'alert' })).toBeUndefined();
  });
});
