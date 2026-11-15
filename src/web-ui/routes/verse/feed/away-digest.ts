/**
 * routes/verse/feed/away-digest.ts: the "While you were away" line at the top
 * of the Feed — one digest of everything that landed since Mason's last look
 * (feed-seen-store.ts), built only from the items already on screen. Pure; no
 * reads of its own.
 *
 * It appears only when the newest unseen item sits more than AWAY_MIN_MINUTES
 * past last-seen — under that, the plain "N new" bar already says enough. The
 * unseen items group, in order, into:
 *
 *   merge    kind 'merge' — merged PRs
 *   release  release feed items (`release:<version>:<state>` ids) and update
 *            news that names a version
 *   hold     a lane, repo or queue held ("held" text, owner-hold/queue-held ids)
 *   ask      every other needs-you alert — the drawer entries waiting on him
 *   other    leader, owner, fleet, bus, Dot, comms and non-release updates
 */
import { formatDuration } from '../autonomy/format.js';
import type { FeedFilter, FeedItem, FeedKind } from './feed-model.js';

/** Under this gap between last-seen and the newest unseen item, no card. */
export const AWAY_MIN_MINUTES = 45;
export const AWAY_MIN_MS = AWAY_MIN_MINUTES * 60_000;

export type AwayGroupId = 'merge' | 'release' | 'hold' | 'ask' | 'other';

export interface AwayPart {
  id: AwayGroupId;
  /** Unseen items in this group. */
  count: number;
  /** The clickable words: "14 PRs merged", "release 3.30.32 published". */
  text: string;
  /** The filter a click applies; undefined for the mixed "other" tail, which no one filter shows. */
  filter?: FeedFilter;
}

export interface AwayDigest {
  /** "3h 10m" — how long since Mason's last Feed view. */
  awayFor: string;
  /** The newest unseen item's time; dismissing the card marks this seen. */
  newestAt: string;
  parts: AwayPart[];
}

const VERSION_RE = /v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?/;
const HOLD_ID_RE = /:(?:owner-hold|queue-held):/;
const HELD_TEXT_RE = /\bheld\b|\bhold\b/i;
/** "Lane codex-cmp held: usage" / "codex-cmp lane is held (quota)" / "devin held — spend". */
const LANE_HELD_RE = /\blane\s+([a-z0-9][\w.-]*)\s+(?:is\s+)?held\b[:\s—–-]*([^\n.;)]*)|\b([a-z0-9][\w.-]*)\s+lane\s+(?:is\s+)?held\b[:\s—–-]*([^\n.;)]*)|\b([a-z0-9][\w.-]*)\s+held\b[:\s—–-]*([^\n.;)]*)/i;
/** English words a loose "<word> held" match must not take for a lane name. */
const NON_NAME_RE = /^(?:a|after|an|and|are|as|at|be|been|before|both|by|during|each|fleet|for|he|held|hold|i|if|in|is|it|items?|its|jobs?|lanes?|no|not|now|of|on|once|or|prs?|queued?|repos?|she|still|the|they|to|until|was|we|were|when|while|you)$/i;
const REASON_MAX = 24;

const RELEASE_STATE: Record<string, string> = {
  published: 'published', installed: 'installed', 'feed-ready': 'feed ready',
  'assets-incomplete': 'assets incomplete', 'publication-unknown': 'state unknown',
  'feed-unknown': 'feed unknown', 'release-unknown': 'state unknown',
};

/** A single-kind group's filter; 'fleet' (lane holds' other home) has no filter of its own. */
const KIND_FILTER: Partial<Record<FeedKind, FeedFilter>> = { merge: 'merge', update: 'update', alert: 'alert' };

const GROUP_ORDER: readonly AwayGroupId[] = ['merge', 'release', 'hold', 'ask', 'other'];
/** Fallback when a group's items span kinds (no single filter shows them all). */
const GROUP_FILTER: Record<AwayGroupId, FeedFilter | undefined> = { merge: 'merge', release: 'update', hold: 'alert', ask: 'alert', other: undefined };

/** Which of the five digest buckets an unseen item belongs to. */
export function awayGroup(item: FeedItem): AwayGroupId {
  if (item.kind === 'merge') return 'merge';
  if (item.id.startsWith('release:') || (item.kind === 'update' && VERSION_RE.test(item.title))) return 'release';
  if (HOLD_ID_RE.test(item.id) || HELD_TEXT_RE.test(item.title) || HELD_TEXT_RE.test(item.body ?? '')) return 'hold';
  if (item.kind === 'alert') return 'ask';
  return 'other';
}

/** "published", "installed" — the release item's state, from its id-state or its title. */
function releaseState(item: FeedItem, idState: string | undefined): string {
  if (idState && RELEASE_STATE[idState]) return RELEASE_STATE[idState];
  if (/\bpublic|published\b/i.test(item.title)) return 'published';
  if (/\binstalled\b/i.test(item.title)) return 'installed';
  if (/\bheld|failed\b/i.test(item.title)) return 'held';
  return 'update';
}

/** The version a release item announces, from its `release:` id or a semver in its title; no leading "v". */
function releaseVersion(item: FeedItem, idVersion: string | undefined): string | undefined {
  const found = idVersion ?? item.title.match(VERSION_RE)?.[0];
  return found?.replace(/^v/, '');
}

/** "codex-cmp: usage" — the held lane and its reason when the text names them; the hold's ref from its id otherwise. */
function holdRef(item: FeedItem): { label: string; lane: boolean } | undefined {
  const match = `${item.title}\n${item.body ?? ''}`.match(LANE_HELD_RE);
  const name = match?.[1] ?? match?.[3] ?? match?.[5];
  if (match && name && !NON_NAME_RE.test(name)) {
    const reason = (match[2] ?? match[4] ?? match[6] ?? '').trim().replace(/^\(+|\)+$/g, '').slice(0, REASON_MAX);
    return { label: `${name}${reason ? `: ${reason}` : ''}`, lane: true };
  }
  const ref = item.id.match(/:(?:owner-hold|queue-held):(.+)$/)?.[1];
  return ref ? { label: ref, lane: false } : undefined;
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

function partText(id: AwayGroupId, items: FeedItem[]): string {
  const n = items.length;
  if (id === 'merge') return `${n} ${plural(n, 'PR')} merged`;
  if (id === 'release') {
    if (n > 1) return `${n} release updates`;
    const seg = items[0]!.id.split(':');
    const version = releaseVersion(items[0]!, seg[0] === 'release' ? seg[1] : undefined);
    return version ? `release ${version} ${releaseState(items[0]!, seg[0] === 'release' ? seg[2] : undefined)}` : '1 release update';
  }
  if (id === 'hold') {
    const refs = items.map(holdRef);
    const labels = [...new Set(refs.map(ref => ref?.label).filter((label): label is string => Boolean(label)))];
    const detail = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3}` : '');
    const noun = refs.every(ref => ref?.lane) ? `${plural(n, 'lane')} held` : 'held';
    return `${n} ${noun}${detail ? ` (${detail})` : ''}`;
  }
  if (id === 'ask') return `${n} ${plural(n, 'ask')} waiting`;
  return `${n} other ${plural(n, 'update')}`;
}

function partFilter(id: AwayGroupId, items: FeedItem[]): FeedFilter | undefined {
  if (id === 'other') return undefined;
  const kinds = new Set(items.map(item => item.kind));
  // One kind maps to its own filter when the Feed has one; a mixed group takes
  // the fallback that shows at least part of it.
  if (kinds.size === 1) return KIND_FILTER[[...kinds][0]!];
  return GROUP_FILTER[id];
}

/**
 * The away digest, or null: no last-seen time (first launch stamps it), nothing
 * unseen, or the newest unseen item is not yet AWAY_MIN_MINUTES past last-seen.
 */
export function buildAwayDigest(items: readonly FeedItem[], lastSeenAt: string | null | undefined, now: number = Date.now()): AwayDigest | null {
  const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(seenMs)) return null;
  const unseen = items.flatMap(item => {
    const ms = Date.parse(item.at);
    return Number.isFinite(ms) && ms > seenMs ? [{ item, ms }] : [];
  }).sort((a, b) => b.ms - a.ms);
  const newest = unseen[0];
  if (!newest || newest.ms - seenMs <= AWAY_MIN_MS) return null;
  const groups = new Map<AwayGroupId, FeedItem[]>();
  for (const { item } of unseen) {
    const id = awayGroup(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  const parts: AwayPart[] = [];
  for (const id of GROUP_ORDER) {
    const group = groups.get(id);
    if (!group?.length) continue;
    const filter = partFilter(id, group);
    parts.push({ id, count: group.length, text: partText(id, group), ...(filter ? { filter } : {}) });
  }
  return { awayFor: formatDuration(now - seenMs), newestAt: newest.item.at, parts };
}
