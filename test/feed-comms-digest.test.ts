import { describe, expect, it } from 'vitest';
import { buildCommsDigestFeedItems, type CommsDigestInput } from '../src/core/fleet/feed-comms-digest.js';
import { buildFeed } from '../src/web-ui/routes/verse/feed/feed-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const run = (over: Partial<CommsDigestInput> = {}): CommsDigestInput => ({
  runId: 'run-0001',
  at: '2026-11-09T11:30:00Z',
  inboxes: [{ address: 'inbox-a@example.com', unread: 40 }, { address: 'inbox-b@example.com', unread: 100 }],
  archived: 12,
  drafts: { pending: 2, oldestPendingAt: '2026-11-09T10:00:00Z' },
  dotWaiting: 1,
  ...over,
});

describe('buildCommsDigestFeedItems', () => {
  it('gives a normal item at or under the unread target', () => {
    const [item] = buildCommsDigestFeedItems(run(), NOW);
    expect(item!.kind).toBe('fleet');
    expect(item!.body).toContain('inbox-a@example.com: 40 unread');
    expect(item!.body).toContain('inbox-b@example.com: 100 unread');
    expect(item!.body).toContain('Archived this run: 12');
    expect(item!.body).toContain('Drafts waiting for Mason: 2 (oldest 2h)');
    expect(item!.body).toContain('Texts from Dot waiting for a reply: 1');
  });

  it('alerts when an inbox is over 100 unread', () => {
    const [item] = buildCommsDigestFeedItems(run({ inboxes: [{ address: 'inbox-a@example.com', unread: 101 }] }), NOW);
    expect(item!.kind).toBe('alert');
    expect(item!.title).toContain('inbox-a@example.com has 101 unread');
  });

  it('alerts when a draft is older than 12 hours, not at 12', () => {
    expect(buildCommsDigestFeedItems(run({ drafts: { pending: 1, oldestPendingAt: '2026-11-08T23:59:00Z' } }), NOW)[0]!.kind).toBe('alert');
    expect(buildCommsDigestFeedItems(run({ drafts: { pending: 1, oldestPendingAt: '2026-11-09T00:00:00Z' } }), NOW)[0]!.kind).toBe('fleet');
  });

  it('reads an unknown count as "unknown", never 0, and does not alert on it', () => {
    const [item] = buildCommsDigestFeedItems(run({ inboxes: [{ address: 'inbox-a@example.com', unread: null }], archived: null, drafts: null, dotWaiting: undefined }), NOW);
    expect(item!.kind).toBe('fleet');
    expect(item!.body).toContain('inbox-a@example.com: unknown unread');
    expect(item!.body).toContain('Archived this run: unknown');
    expect(item!.body).toContain('Drafts waiting for Mason: unknown');
    expect(item!.body).toContain('Dot waiting for a reply: unknown');
    expect(item!.body).not.toMatch(/: 0\b/);
  });

  it('gives the same id for the same run, whatever the clock', () => {
    const a = buildCommsDigestFeedItems(run(), NOW)[0]!;
    const b = buildCommsDigestFeedItems(run(), NOW + 60_000)[0]!;
    expect(a.id).toBe(b.id);
    expect(buildCommsDigestFeedItems(run({ runId: 'run-0002' }), NOW)[0]!.id).not.toBe(a.id);
  });

  it('returns nothing without a run id or a parsable time', () => {
    expect(buildCommsDigestFeedItems(null, NOW)).toEqual([]);
    expect(buildCommsDigestFeedItems(run({ runId: '' }), NOW)).toEqual([]);
    expect(buildCommsDigestFeedItems(run({ at: 'nope' }), NOW)).toEqual([]);
  });

  it('reaches the Feed once per run across polls', () => {
    const feed = buildFeed({ comms: run() }, 100, NOW);
    expect(feed.filter(i => i.id === 'comms-digest:run-0001')).toHaveLength(1);
  });
});
