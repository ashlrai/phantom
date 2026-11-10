import { describe, expect, it } from 'vitest';
import type { UnifiedInboxEntry, UnifiedInboxView } from '../fleet-inbox/unified-inbox-model.js';
import { buildFeed, commsWaitingAdapter, filterFeed } from './feed-model.js';

const entry = (overrides: Partial<UnifiedInboxEntry> = {}): UnifiedInboxEntry => ({
  id: 'work', source: 'gmail', kind: 'gmail-over-target', severity: 'warn', blocking: false,
  title: 'Work inbox', since: '2026-11-09T10:00:00Z', expiresAt: null, act: [], ...overrides,
});
const view = (...items: UnifiedInboxEntry[]): UnifiedInboxView & { generatedAt: string } => ({
  generatedAt: '2026-11-09T12:00:00Z', total: items.length, omitted: 0, sources: {}, items,
});

describe('waiting communications in the feed', () => {
  it('maps Gmail and LinkedIn, leaving teammate texts to their adapter', () => {
    const inbox = view(entry(), entry({ id: 'message', source: 'linkedin', kind: 'linkedin-message', title: 'Reply to Alex' }),
      entry({ id: 'dot', source: 'imessage', kind: 'teammate-text', title: 'Dot text' }));
    expect(commsWaitingAdapter(inbox)).toEqual([
      { id: 'gmail:work', at: '2026-11-09T10:00:00Z', kind: 'alert', title: 'Work inbox', label: 'Gmail over target' },
      { id: 'linkedin:message', at: '2026-11-09T10:00:00Z', kind: 'comms', title: 'Reply to Alex', label: 'LinkedIn waiting' },
    ]);
    const feed = buildFeed({ teammate: inbox });
    expect(feed).toHaveLength(3);
    expect(filterFeed(feed, 'comms').map(item => item.id)).toEqual(['gmail:work', 'linkedin:message']);
  });
  it('uses the snapshot time only for Gmail without a time and skips invalid times', () => {
    const inbox = view(entry({ since: null }), entry({ id: 'bad', since: 'bad' }),
      entry({ id: 'linked', kind: 'linkedin-message', since: null }));
    expect(commsWaitingAdapter(inbox).map(item => item.id)).toEqual(['gmail:work']);
    expect(commsWaitingAdapter({ ...inbox, generatedAt: 'bad' })).toEqual([]);
    expect(commsWaitingAdapter({ unavailable: true })).toEqual([]);
  });
  it('orders the waiting entries alongside existing items', () => {
    const feed = buildFeed({ teammate: view(entry(), entry({ id: 'linked', kind: 'linkedin-message', since: '2026-11-09T11:00:00Z' })),
      shared: { schema: 'phantom.feed.v1', sources: { merges: 'available', releases: 'unknown', incidents: 'unknown', leaderReplies: 'available' },
        items: [{ kind: 'merge', at: '2026-11-09T10:30:00Z', text: 'Merged' }] } });
    expect(feed.map(item => item.title)).toEqual(['Work inbox', 'Merged', 'Work inbox']);
    expect(feed.map(item => item.id)).toEqual(['linkedin:linked', 'shared:merge:2026-11-09T10:30:00Z:0', 'gmail:work']);
  });
});
