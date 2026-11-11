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
 *   comms    the Comms agent's digest (fleet kind, or alert when an inbox is over
 *            100 unread or a draft is over 12 h old)
 *
 * Pure: one adapter per source, then `buildFeed` dedupes by id, drops items
 * whose time does not parse, sorts newest first and caps the stream. Every
 * text is untrusted (model output, PR titles) and is rendered as plain text.
 */
import { groupMergeBursts } from './feed-merge-burst.js';
import type { FeedReport } from '../../../../core/feed.js';
import { buildCommsDigestFeedItems, type CommsDigestInput } from '../../../../core/fleet/feed-comms-digest.js';
import type { AppNotification } from '../../../components/notifications/types.js';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import type { UnifiedInboxView } from '../fleet-inbox/unified-inbox-model.js';
import type { AgentBusPage } from '../fleet-bus/agent-bus-queries.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import { readMerges } from '../fleet-merges/fleet-merges-model.js';
import { channelName } from '../leader-thread/owner-thread-lines.js';
import type { OwnerThreadLine } from '../leader-thread/owner-thread-queries.js';
import { fleetOutbox } from '../leader-thread/thread-merge-model.js';

export type FeedKind = 'leader' | 'alert' | 'merge' | 'fleet' | 'owner' | 'update' | 'bus' | 'teammate' | 'comms';

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
  /** The registered pane that owns this item (set by buildFeed, see feedItemPane); the Feed offers "Open in …" for it. */
  pane?: FeedPane;
}

/**
 * The panes a Feed item can open, with the words on its link. Ids are the
 * real `*.pane.tsx` registrations; Phantom updates have no pane of their own.
 */
const FEED_PANE_LABEL = {
  'leader-thread': 'Open in Leader',
  'fleet-merges': 'Open in Merges',
  'fleet-events': 'Open in Events',
  'fleet-bus': 'Open in Bus',
  'fleet-inbox': 'Open in Inbox',
} as const;

export type FeedPane = keyof typeof FEED_PANE_LABEL;

/** "Open in Leader", "Open in Merges", …; undefined for an id the Feed does not link to. */
export function feedPaneLabel(paneId: string | undefined): string | undefined {
  return paneId && Object.hasOwn(FEED_PANE_LABEL, paneId) ? FEED_PANE_LABEL[paneId as FeedPane] : undefined;
}

export interface FeedSources {
  shared?: FeedReport;
  leader?: readonly LeaderThreadMessage[] | null;
  /** The raw /api/verse/fleet/runs snapshot (outbox, merges and events). */
  runs?: unknown;
  needsYou?: readonly NeedsYouItem[] | null;
  owner?: readonly OwnerThreadLine[] | null;
  update?: readonly AppNotification[] | null;
  /** The agent bus page; only P0 and P1 messages reach the stream. */
  bus?: AgentBusPage | null;
  teammate?: (UnifiedInboxView & { generatedAt?: string }) | null;
  /** The Comms agent's latest run reading; one digest item per run id. */
  comms?: CommsDigestInput | null;
  inboxPlans?: unknown;
}

export type FeedFilter = 'all' | 'leader' | 'alert' | 'merge' | 'owner' | 'update' | 'bus' | 'teammate' | 'comms';

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

/** Unanswered teammate texts belong in the stream; other inbox entries have their own sources. */
export function teammateAdapter(view: UnifiedInboxView | null | undefined): FeedItem[] {
  if (!view || view.unavailable) return [];
  return view.items.flatMap((entry): FeedItem[] => {
    if (entry.kind !== 'teammate-text' || !entry.since || !Number.isFinite(Date.parse(entry.since))) return [];
    return [{ id: `teammate:${entry.id}`, at: entry.since, kind: 'teammate', ...headline(entry.title), label: 'Dot waiting' }];
  });
}

/** Waiting Gmail and LinkedIn entries share the unified inbox read. */
export function commsWaitingAdapter(view: (UnifiedInboxView & { generatedAt?: string }) | null | undefined): FeedItem[] {
  if (!view || view.unavailable) return [];
  return view.items.flatMap((entry): FeedItem[] => {
    if (entry.kind !== 'gmail-over-target' && entry.kind !== 'linkedin-message') return [];
    const gmail = entry.kind === 'gmail-over-target';
    const at = entry.since ?? (gmail ? view.generatedAt : undefined);
    if (!at || !Number.isFinite(Date.parse(at))) return [];
    return [{ id: `${gmail ? 'gmail' : 'linkedin'}:${entry.id}`, at, kind: gmail ? 'alert' : 'comms',
      ...headline(entry.title), label: gmail ? 'Gmail over target' : 'LinkedIn waiting' }];
  });
}

const KIND_PANE: Partial<Record<FeedKind, FeedPane>> = {
  leader: 'leader-thread', owner: 'leader-thread', merge: 'fleet-merges', fleet: 'fleet-events',
  bus: 'fleet-bus', teammate: 'fleet-inbox', comms: 'fleet-inbox',
};

/**
 * The pane that owns an item: Leader and owner-thread lines → Leader, merges →
 * Merges, fleet events → Events, bus → Bus, Dot, LinkedIn and Gmail → Inbox.
 * Needs-you alerts keep their https link and get no pane; updates have none.
 * Applied in buildFeed so each adapter's output stays the source's own data.
 */
export function feedItemPane(item: Pick<FeedItem, 'id' | 'kind'>): FeedPane | undefined {
  if (item.kind === 'alert') return (item.id.startsWith('gmail:') || item.id.startsWith('inbox-over:')) ? 'fleet-inbox' : undefined;
  return KIND_PANE[item.kind];
}

const INBOX_SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const INBOX_STALE_MS = 24 * 3_600_000;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * One alert per inbox in the saved Gmail archive plan whose unread count is over
 * its target. A payload that is not the plan schema, or any malformed plan row,
 * gives nothing. Plans older than 24 h say so in the title.
 */
export function inboxOverAdapter(payload: unknown, now: number = Date.now()): FeedItem[] {
  const top = record(payload);
  const latest = record(top.latest);
  if (top.schema !== INBOX_SCHEMA || latest.schema !== INBOX_SCHEMA || !Array.isArray(latest.plans)) return [];
  const items: FeedItem[] = [];
  for (const raw of latest.plans as unknown[]) {
    const p = record(raw);
    if (typeof p.inbox !== 'string' || typeof p.at !== 'string' || !isCount(p.unread) || !isCount(p.target) || !isCount(p.archiveCount)) return [];
    if (p.unread <= p.target) continue;
    const then = Date.parse(p.at);
    const stale = Number.isFinite(then) && now - then > INBOX_STALE_MS;
    const senders = (Array.isArray(p.topSenders) ? p.topSenders as unknown[] : []).flatMap(s => {
      const r = record(s);
      return typeof r.sender === 'string' && isCount(r.count) ? [`${r.sender} (${r.count})`] : [];
    }).slice(0, 3);
    items.push({
      id: `inbox-over:${p.inbox}:${p.at}`, at: p.at, kind: 'alert', label: 'Inbox',
      title: `${p.inbox}: ${p.unread} unread, target ${p.target}${stale ? ' (plan is stale)' : ''}`,
      body: `The archive plan would archive ${p.archiveCount}.${senders.length ? ` Top senders: ${senders.join(', ')}` : ''}`,
    });
  }
  return items;
}

/** Every source merged, each item with its owning pane: deduped by id (newest copy wins), unparsable times dropped, newest first, at most FEED_LIMIT. */
export function buildFeed(sources: FeedSources, limit = FEED_LIMIT, now = Date.now()): FeedItem[] {
  const all: FeedItem[] = [
    ...(sources.shared?.items ?? []).map((item, index): FeedItem => ({ id: `shared:${item.kind}:${item.at}:${index}`, at: item.at, kind: item.kind === 'merge' ? 'merge' : 'leader', ...headline(item.text) })),
    ...leaderAdapter(sources.leader),
    ...outboxAdapter(sources.runs),
    ...alertAdapter(sources.needsYou),
    ...mergeAdapter(sources.runs),
    ...fleetEventAdapter(sources.runs),
    ...ownerAdapter(sources.owner),
    ...updateAdapter(sources.update),
    ...busAdapter(sources.bus),
    ...teammateAdapter(sources.teammate),
    ...commsWaitingAdapter(sources.teammate),
    ...buildCommsDigestFeedItems(sources.comms, now),
    ...inboxOverAdapter(sources.inboxPlans, now),
  ];
  const timed = all.flatMap(item => {
    const ms = Date.parse(item.at);
    if (!Number.isFinite(ms)) return [];
    const pane = feedItemPane(item);
    return [{ item: { ...item, at: new Date(ms).toISOString(), ...(pane ? { pane } : {}) }, ms }];
  }).sort((a, b) => b.ms - a.ms);
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const { item } of timed) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return groupMergeBursts(out).slice(0, Math.max(0, limit));
}

export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  return filter === 'all' ? [...items] : items.filter(item => item.kind === filter || (filter === 'comms' && item.kind === 'alert' && item.id.startsWith('gmail:')));
}
