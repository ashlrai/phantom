import { describe, expect, it } from 'vitest';
import type { UnifiedInboxEntry, UnifiedInboxView } from '../fleet-inbox/unified-inbox-model.js';
import { buildFeed, filterFeed, teammateAdapter } from './feed-model.js';

const entry = (overrides: Partial<UnifiedInboxEntry> = {}): UnifiedInboxEntry => ({
  id: 'imessage:teammate-1', source: 'imessage', kind: 'teammate-text', severity: 'info',
  blocking: false, title: 'Hello\nPlease reply', since: '2026-11-09T10:00:00Z', expiresAt: null, act: [], ...overrides,
});
const view = (...items: UnifiedInboxEntry[]): UnifiedInboxView => ({ total: items.length, omitted: 0, sources: {}, items });

describe('teammate feed', () => {
  it('maps only teammate texts with valid arrival times', () => {
    expect(teammateAdapter(view(entry(), entry({ id: 'other', kind: 'bus-work' }), entry({ id: 'bad', since: 'bad' })))).toEqual([
      { id: 'teammate:imessage:teammate-1', at: '2026-11-09T10:00:00Z', kind: 'teammate', title: 'Hello', body: 'Hello\nPlease reply', label: 'Dot waiting' },
    ]);
  });

  it('deduplicates by id and filters to teammate', () => {
    const feed = buildFeed({ teammate: view(entry(), entry({ title: 'Newer', since: '2026-11-09T11:00:00Z' })), needsYou: [] });
    expect(feed).toHaveLength(1);
    expect(feed[0]?.title).toBe('Newer');
    expect(filterFeed(feed, 'teammate')).toEqual(feed);
    expect(filterFeed(feed, 'bus')).toEqual([]);
  });

  it('adds nothing for unavailable or null views', () => {
    expect(buildFeed({ teammate: { unavailable: true } })).toEqual([]);
    expect(buildFeed({ teammate: null })).toEqual([]);
  });
});
