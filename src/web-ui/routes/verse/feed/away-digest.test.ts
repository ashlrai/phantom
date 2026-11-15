import { describe, expect, it } from 'vitest';
import { AWAY_MIN_MS, awayGroup, buildAwayDigest } from './away-digest.js';
import type { FeedItem } from './feed-model.js';

const NOW = Date.parse('2026-11-10T20:00:00.000Z');
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
const item = (partial: Partial<FeedItem> & Pick<FeedItem, 'id' | 'kind'>): FeedItem => ({ at: ago(120), title: 'x', ...partial });
const merge = (n: number, at = ago(120)): FeedItem => ({ id: `merge:ashlrai/phantom#${n}`, at, kind: 'merge', title: `Merged PR ${n}` });

// Last look 3h10m ago; the newest unseen item 100m ago → the 90m gap shows the card.
const SEEN = ago(190);
const newest = ago(100);

describe('buildAwayDigest gating', () => {
  it('returns null when last-seen is unset or unparseable', () => {
    for (const seen of [null, undefined, '', 'not a date']) {
      expect(buildAwayDigest([item({ id: 'leader:1', kind: 'leader', at: newest })], seen, NOW)).toBeNull();
    }
  });

  it('returns null when nothing counts as unseen — old items, an item at last-seen, unparseable times', () => {
    const items = [item({ id: 'leader:1', kind: 'leader', at: ago(300) }), item({ id: 'leader:2', kind: 'leader', at: SEEN }), item({ id: 'leader:3', kind: 'leader', at: 'garbage' })];
    expect(buildAwayDigest(items, SEEN, NOW)).toBeNull();
  });

  it('returns null while the newest unseen item is within the threshold, boundary included', () => {
    const items = [item({ id: 'leader:1', kind: 'leader', at: ago(160) })]; // 30m after seen
    expect(buildAwayDigest(items, SEEN, NOW)).toBeNull();
    const boundary = [item({ id: 'leader:1', kind: 'leader', at: ago(190 - AWAY_MIN_MS / MIN) })];
    expect(buildAwayDigest(boundary, SEEN, NOW)).toBeNull();
    expect(buildAwayDigest([item({ id: 'leader:1', kind: 'leader', at: ago(100) })], ago(80), NOW)).toBeNull(); // everything is already seen
  });

});

describe('buildAwayDigest grouping', () => {
  const items: FeedItem[] = [
    merge(1, newest), merge(2), merge(3),
    { id: 'release:v3.30.32:published', at: ago(110), kind: 'update', title: 'v3.30.32 is public; the required desktop assets are present.' },
    { id: 'fleet:e1', at: ago(115), kind: 'fleet', title: 'Lane codex-cmp held: usage' },
    { id: 'fleet:e2', at: ago(118), kind: 'fleet', title: 'Lane devin held: quota' },
    { id: 'alert:leader:veto-window:a2', at: ago(119), kind: 'alert', title: 'Leader will raise Grok to 3 lanes in 18m' },
    { id: 'leader:m1', at: ago(121), kind: 'leader', title: 'Morning memo' },
    { id: 'owner:o1', at: ago(122), kind: 'owner', title: 'Mason via Telegram' },
    { id: 'bus:b1', at: ago(123), kind: 'bus', title: 'agent → agent · P1' },
  ];

  it('keeps the order merges, releases, lane holds, asks, other and counts each', () => {
    const digest = buildAwayDigest(items, SEEN, NOW)!;
    expect(digest.parts.map(part => part.id)).toEqual(['merge', 'release', 'hold', 'ask', 'other']);
    expect(digest.parts.map(part => [part.count, part.text])).toEqual([
      [3, '3 PRs merged'],
      [1, 'release 3.30.32 published'],
      [2, '2 lanes held (codex-cmp: usage, devin: quota)'],
      [1, '1 ask waiting'],
      [3, '3 other updates'],
    ]);
    expect(digest.newestAt).toBe(newest);
  });

  it('gives each part the filter that shows its kind; the mixed tail has none', () => {
    const digest = buildAwayDigest(items, SEEN, NOW)!;
    const filter = Object.fromEntries(digest.parts.map(part => [part.id, part.filter]));
    expect(filter).toEqual({ merge: 'merge', release: 'update', hold: undefined, ask: 'alert', other: undefined });
  });

  it('routes every leftover kind to "other"', () => {
    for (const kind of ['leader', 'owner', 'bus', 'teammate', 'comms'] as const) {
      expect(awayGroup(item({ id: `${kind}:1`, kind }))).toBe('other');
    }
    expect(awayGroup(item({ id: 'fleet:e1', kind: 'fleet', title: 'Lane codex-2 paused: disk low' }))).toBe('other');
    expect(awayGroup(item({ id: 'update:u1', kind: 'update', title: 'Daily summary ready' }))).toBe('other');
    expect(awayGroup(item({ id: 'alert:gmail:1', kind: 'alert', title: 'Inbox over target' }))).toBe('ask');
  });

  it('reads held state from needs-you ids and hold text alike', () => {
    expect(awayGroup(item({ id: 'alert:fleet:owner-hold:ashlrai/binshield', kind: 'alert', title: 'binshield on owner-hold' }))).toBe('hold');
    expect(awayGroup(item({ id: 'alert:chats:queue-held:s1', kind: 'alert', title: 'Reply queued — held' }))).toBe('hold');
    expect(awayGroup(item({ id: 'fleet:e1', kind: 'fleet', title: 'Lane grok held: spend' }))).toBe('hold');
  });

  it('names a single release, counts many, and spots a versioned update', () => {
    const one = [item({ id: 'release:v3.30.32:published', at: newest, kind: 'update', title: 'v3.30.32 is public.' })];
    expect(buildAwayDigest(one, SEEN, NOW)!.parts[0]!.text).toBe('release 3.30.32 published');
    const two = [...one, item({ id: 'update:u1', at: ago(110), kind: 'update', title: 'v3.30.33 is ready to install.' })];
    expect(buildAwayDigest(two, SEEN, NOW)!.parts[0]!.text).toBe('2 release updates');
  });

  it('falls back to a bare hold count when no lane is named', () => {
    const items = [item({ id: 'alert:fleet:owner-hold:ashlrai/binshield', kind: 'alert', title: 'binshield on owner-hold', at: newest })];
    expect(buildAwayDigest(items, SEEN, NOW)!.parts[0]!.text).toBe('1 held (ashlrai/binshield)');
    const unnamed = [item({ id: 'alert:1', kind: 'alert', title: 'A hold is on', at: newest })];
    expect(buildAwayDigest(unnamed, SEEN, NOW)!.parts[0]!.text).toBe('1 held');
  });
});

describe('buildAwayDigest duration', () => {
  it('reports the time since the last look', () => {
    const digest = buildAwayDigest([item({ id: 'leader:1', kind: 'leader', at: newest })], SEEN, NOW)!;
    expect(digest.awayFor).toBe('3h 10m');
    expect(buildAwayDigest([item({ id: 'leader:1', kind: 'leader', at: ago(10) })], ago(120), NOW)!.awayFor).toBe('2h 00m');
  });
});
