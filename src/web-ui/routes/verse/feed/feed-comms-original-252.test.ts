/**
 * feed-comms-original-252.test.ts: composition coverage for the Comms run
 * digest preserved from PR #4335 (RQ-PHX-FEEDCOMMSDIGEST10, original commit
 * 585222707678f8fb5db09f41253a040f1ac88ad5). The digest builder's own unit
 * behavior is covered by test/feed-comms-digest.test.ts; this file pins how
 * the digest survives the real buildFeed/filterFeed composition alongside the
 * other feed sources, using plainly fake readings and a fixed clock.
 */
import { describe, expect, it } from 'vitest';
import type { CommsDigestInput } from '../../../../core/fleet/feed-comms-digest.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { buildFeed, filterFeed } from './feed-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const commsRun = (over: Partial<CommsDigestInput> = {}): CommsDigestInput => ({
  runId: 'run-0001',
  at: at(30),
  inboxes: [{ address: 'inbox-a@example.com', unread: 40 }, { address: 'inbox-b@example.com', unread: 100 }],
  archived: 12,
  drafts: { pending: 2, oldestPendingAt: at(150) },
  dotWaiting: 1,
  ...over,
});

const runs = {
  outbox: [{ at: at(5), text: 'Shipped the lane fix.' }],
  mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Feed pane', mergedAt: at(2) }] },
  events: [{ at: at(8), kind: 'pause', text: 'Lane codex-2 paused: disk low' }],
};

const digestOf = (feed: ReturnType<typeof buildFeed>) => feed.find(item => item.id === 'comms-digest:run-0001');

describe('Comms run digest in the composed feed', () => {
  it('keeps the digest among the other sources, ordered by its run time', () => {
    const feed = buildFeed({
      leader: [msg({ id: 'l1', at: at(1), text: 'Leader note.' })],
      runs,
      comms: commsRun(),
    }, 100, NOW);
    expect(feed.map(item => item.id)).toEqual([
      'leader:l1',
      'merge:ashlrai/phantom#42',
      expect.stringMatching(/^outbox:/),
      expect.stringMatching(/^fleet:/),
      'comms-digest:run-0001',
    ]);
    const digest = digestOf(feed)!;
    expect(digest).toMatchObject({ kind: 'fleet', at: at(30), title: 'Comms digest', label: 'Comms', pane: 'fleet-events' });
    expect(digest.body).toContain('inbox-a@example.com: 40 unread');
    expect(digest.body).toContain('Archived this run: 12');
    expect(digest.body).toContain('Texts from Dot waiting for a reply: 1');
  });

  it('keeps one digest id across repeated polls of the same run', () => {
    const first = buildFeed({ comms: commsRun() }, 100, NOW);
    const second = buildFeed({ comms: commsRun({ drafts: { pending: 3, oldestPendingAt: at(160) } }) }, 100, NOW + 60_000);
    for (const feed of [first, second]) {
      expect(feed.filter(item => item.id === 'comms-digest:run-0001')).toHaveLength(1);
    }
    // The supported path rebuilds the stream each poll, so the stable
    // `comms-digest:<runId>` id can never accumulate a second copy.
    expect(digestOf(second)!.id).toBe(digestOf(first)!.id);
    expect(digestOf(second)!.body).toContain('Drafts waiting for Mason: 3');
    const other = buildFeed({ comms: commsRun({ runId: 'run-0002' }) }, 100, NOW);
    expect(other.some(item => item.id === 'comms-digest:run-0002')).toBe(true);
    expect(other.some(item => item.id === 'comms-digest:run-0001')).toBe(false);
  });

  it('keeps missing unread, archive and Dot counts unknown, never 0', () => {
    const feed = buildFeed({ comms: commsRun({ inboxes: null, archived: null, drafts: null, dotWaiting: null }) }, 100, NOW);
    const digest = digestOf(feed)!;
    expect(digest.kind).toBe('fleet');
    expect(digest.body).toContain('Unread: unknown (target 100 or fewer)');
    expect(digest.body).toContain('Archived this run: unknown');
    expect(digest.body).toContain('Drafts waiting for Mason: unknown');
    expect(digest.body).toContain('Texts from Dot waiting for a reply: unknown');
    expect(digest.body).not.toMatch(/: 0\b/);
    const empty = buildFeed({ comms: commsRun({ inboxes: [] }) }, 100, NOW);
    expect(digestOf(empty)!.body).toContain('Unread: unknown (target 100 or fewer)');
  });

  it('surfaces the unread and stale-draft alerts through composition', () => {
    const unread = buildFeed({ comms: commsRun({ inboxes: [{ address: 'inbox-a@example.com', unread: 101 }] }) }, 100, NOW);
    const alert = digestOf(unread)!;
    expect(alert.kind).toBe('alert');
    expect(alert.title).toContain('inbox-a@example.com has 101 unread');
    // Current routing: only gmail:/inbox-over: alerts get the Inbox pane.
    expect(alert.pane).toBeUndefined();
    expect(filterFeed(unread, 'alert').map(item => item.id)).toContain('comms-digest:run-0001');
    // Current 'comms' filter covers waiting-channel entries, not the run digest.
    expect(filterFeed(unread, 'comms').map(item => item.id)).not.toContain('comms-digest:run-0001');

    const stale = buildFeed({ comms: commsRun({ drafts: { pending: 1, oldestPendingAt: at(13 * 60) } }) }, 100, NOW);
    expect(digestOf(stale)!.kind).toBe('alert');
    expect(digestOf(stale)!.title).toContain('a draft has waited over 12h');
  });

  it('drops malformed digest input from the composed stream', () => {
    for (const comms of [null, commsRun({ runId: '' }), commsRun({ at: 'not-a-date' })]) {
      const feed = buildFeed({ comms, leader: [msg({ id: 'l', at: at(1), text: 'Hi' })] }, 100, NOW);
      expect(feed.map(item => item.id)).toEqual(['leader:l']);
    }
  });
});
