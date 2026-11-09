/**
 * routes/verse/feed/feed-model.ts: the Feed's one time-ordered stream, built
 * from reads other panes already make (no route of its own):
 *
 *   leader   the Leader's thread messages and the fleet outbox answers
 *   alert    Needs-you items (GET /api/verse/activity)
 *   merge    PRs merged in the last hour (GET /api/verse/fleet/runs)
 *   fleet    fleet events from the same runs read
 *   owner    Mason's messages on Telegram, Slack, email and iMessage, and the
 *            Leader's replies with where they went (owner thread)
 *   update   Phantom update news: ready, held, failed, applied (the notification
 *            tray's derived update items; no route of its own)
 *   bus      urgent (P0, P1) agent-to-agent messages from the agent bus page
 *
 * Pure: one adapter per source, then `buildFeed` dedupes by id, drops items
 * whose time does not parse, sorts newest first and caps the stream. Every
 * text is untrusted (model output, PR titles) and is rendered as plain text.
 */
import type { AppNotification } from '../../../components/notifications/types.js';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import type { AgentBusPage } from '../fleet-bus/agent-bus-queries.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import { readMerges } from '../fleet-merges/fleet-merges-model.js';
import { channelName } from '../leader-thread/owner-thread-lines.js';
import type { OwnerThreadLine } from '../leader-thread/owner-thread-queries.js';
import { fleetOutbox } from '../leader-thread/thread-merge-model.js';

export type FeedKind = 'leader' | 'alert' | 'merge' | 'fleet' | 'owner' | 'update' | 'bus';

export interface FeedItem {
  id: string;
  /** ISO time, normalised by buildFeed. */
  at: string;
  kind: FeedKind;
  title: string;
  body?: string;
  href?: string;
  /** Shown on the kind chip instead of the kind's name, e.g. "Mason via Telegram". */
  label?: string;
}

export interface FeedSources {
  leader?: readonly LeaderThreadMessage[] | null;
  /** The raw /api/verse/fleet/runs snapshot (outbox, merges and events). */
  runs?: unknown;
  needsYou?: readonly NeedsYouItem[] | null;
  owner?: readonly OwnerThreadLine[] | null;
  update?: readonly AppNotification[] | null;
  /** The agent bus page; only P0 and P1 messages reach the stream. */
  bus?: AgentBusPage | null;
}

export type FeedFilter = 'all' | 'leader' | 'alert' | 'merge' | 'owner' | 'update' | 'bus';

export const FEED_LIMIT = 100;
const TITLE_MAX = 120;

/** The first line as the title (≤120 chars); the full text as the body when the title does not already say it all. */
function headline(text: string): Pick<FeedItem, 'title' | 'body'> {
  const trimmed = text.trim();
  const first = trimmed.split('\n', 1)[0]!.trim();
  const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
  return title === trimmed ? { title } : { title, body: trimmed };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The Leader's own messages; Mason's lines are not news to Mason. */
export function leaderAdapter(messages: readonly LeaderThreadMessage[] | null | undefined): FeedItem[] {
  return (messages ?? []).filter(m => m.from === 'leader' && m.text.trim()).map(m => ({ id: `leader:${m.id}`, at: m.at, kind: 'leader', ...headline(m.text) }));
}

/** Fleet outbox answers (the leaders' replies that went out over the bus). */
export function outboxAdapter(runs: unknown): FeedItem[] {
  return fleetOutbox(runs).filter(row => row.text.trim()).map(row => ({ id: `outbox:${row.at}:${row.text.slice(0, 40)}`, at: row.at, kind: 'leader', ...headline(row.text) }));
}

export function alertAdapter(items: readonly NeedsYouItem[] | null | undefined): FeedItem[] {
  return (items ?? []).map(item => {
    const href = item.target.kind === 'url' && item.target.url.startsWith('https://') ? item.target.url : undefined;
    return { id: `alert:${item.id}`, at: item.since, kind: 'alert', title: item.title, ...(item.detail ? { body: item.detail } : {}), ...(href ? { href } : {}) };
  });
}

export function mergeAdapter(runs: unknown): FeedItem[] {
  return readMerges(runs).merged.map(m => ({
    id: `merge:${m.repo}#${m.number}`,
    at: m.mergedAt ?? m.at ?? m.openedAt ?? '',
    kind: 'merge',
    title: m.title,
    body: `${m.repo} #${m.number}`,
    ...(m.href ? { href: m.href } : {}),
  }));
}

export function fleetEventAdapter(runs: unknown): FeedItem[] {
  const events = record(runs).events;
  return (Array.isArray(events) ? events : []).flatMap(raw => {
    const e = record(raw);
    if (typeof e.at !== 'string' || typeof e.text !== 'string' || !e.text.trim()) return [];
    const kind = typeof e.kind === 'string' ? e.kind : 'event';
    return [{ id: `fleet:${e.at}:${kind}:${e.text.slice(0, 40)}`, at: e.at, kind: 'fleet' as const, ...headline(e.text) }];
  });
}

/**
 * Owner-thread lines with the thread's own wording: "Mason via <channel>" in,
 * "Leader → <fanout>" out. Desktop inbound lines are dropped: Mason typed them
 * in this app.
 */
export function ownerAdapter(rows: readonly OwnerThreadLine[] | null | undefined): FeedItem[] {
  return (rows ?? []).flatMap((row): FeedItem[] => {
    const inbound = row.direction === 'inbound';
    if ((inbound && row.channel === 'desktop') || !row.text.trim()) return [];
    const targets = row.fanout?.length ? row.fanout : [row.channel];
    return [{ id: `owner:${row.id}`, at: row.at, kind: 'owner', ...headline(row.text),
      label: inbound ? `Mason via ${channelName(row.channel)}` : `Leader → ${targets.map(channelName).join(', ')}` }];
  });
}

/** Update notifications as plain data; the stable notification id dedupes a version's news across polls. */
export function updateAdapter(items: readonly AppNotification[] | null | undefined): FeedItem[] {
  return (items ?? []).map(item => ({ id: `update:${item.id}`, at: item.ts, kind: 'update', title: item.title, ...(item.detail ? { body: item.detail } : {}) }));
}

/** The message text of a bus body: its `text` when it has one, else the body as JSON. */
function busText(body: unknown): string {
  const text = record(body).text;
  return typeof text === 'string' ? text : JSON.stringify(body) ?? '';
}

/** Urgent agent-to-agent messages only (P0, P1), so routine bus chatter does not flood the stream. A bad receivedAt gives an invalid date, which buildFeed drops. */
export function busAdapter(page: AgentBusPage | null | undefined): FeedItem[] {
  return (page?.messages ?? []).flatMap((row): FeedItem[] => {
    const { envelope, receivedAt } = row;
    if ((envelope.priority !== 'P0' && envelope.priority !== 'P1') || !busText(envelope.body).trim()) return [];
    const ms = new Date(receivedAt).getTime();
    return [{ id: `bus:${envelope.id}`, at: Number.isFinite(ms) ? new Date(ms).toISOString() : '', kind: 'bus',
      ...headline(busText(envelope.body)), label: `${envelope.from} → ${envelope.to} · ${envelope.priority}` }];
  });
}

/** Every source merged: deduped by id (newest copy wins), unparsable times dropped, newest first, at most FEED_LIMIT. */
export function buildFeed(sources: FeedSources, limit = FEED_LIMIT): FeedItem[] {
  const all = [
    ...leaderAdapter(sources.leader),
    ...outboxAdapter(sources.runs),
    ...alertAdapter(sources.needsYou),
    ...mergeAdapter(sources.runs),
    ...fleetEventAdapter(sources.runs),
    ...ownerAdapter(sources.owner),
    ...updateAdapter(sources.update),
    ...busAdapter(sources.bus),
  ];
  const timed = all.flatMap(item => {
    const ms = Date.parse(item.at);
    return Number.isFinite(ms) ? [{ item: { ...item, at: new Date(ms).toISOString() }, ms }] : [];
  }).sort((a, b) => b.ms - a.ms);
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const { item } of timed) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  return filter === 'all' ? [...items] : items.filter(item => item.kind === filter);
}
