/**
 * Pure thread model for agent-to-agent messages (no bus, no Node imports, so the
 * web UI can share it). See agent-conversations.ts for the bus read.
 */
import type { AgentMessageKind } from './agent-messages.js';
import type { AgentIdentityKeyFor } from '../agents/bus-identity.js';
import type { BusPriority } from './bus-envelope.js';

export const CONVERSATION_STATES = ['waiting', 'answered', 'blocked', 'done'] as const;
export type ConversationState = typeof CONVERSATION_STATES[number];
/** A line on the map shows for talk this recent. */
export const CONVERSATION_LINE_WINDOW_MS = 10 * 60_000;
export const UNKNOWN_AGENT = 'unknown agent';
/** The job bucket prefix a declared or derived conversation key carries (`job:<id>`); agent-messages owns the wire constant. */
const JOB_BUCKET_PREFIX = 'job:';
/** What a person reads for each state. */
export const CONVERSATION_STATE_WORDS: Readonly<Record<ConversationState, string>> = {
  waiting: 'waiting for reply', answered: 'answered', blocked: 'blocked', done: 'done',
};

/** One bus message as the projection needs it. `to` may be an agent or a topic. */
export interface ConversationMessage {
  id: string;
  from: string;
  to: string;
  kind: AgentMessageKind;
  /** One scrubbed line. */
  subject: string;
  /** Epoch ms. */
  at: number;
  replyTo: string | null;
  /** Explicit thread bucket: the declared conversation key (a thread label or `job:<id>`), never the synthesized `pair:` fallback; overrides reply-chain rooting. */
  thread?: string | null;
  /** Job ids this message names — a body job citation, its reported job link or its `job:<id>` bucket; absent when it names none. */
  jobIds?: readonly string[];
  /** What the sender said about the work itself, when it said. */
  state: 'blocked' | 'done' | null;
  /** Provider lane when a label proves it (the bus knows it), else null. */
  lane?: string | null;
  /** The envelope priority band the message was stamped with; absent only
   * when a caller-built message carries none — the read always sets it, so a
   * member message with no recorded band names no provable band and never
   * matches a `priority` filter. */
  priority?: BusPriority;
  /** The body's own `inReplyTo` citation, verbatim — never the `replyTo`
   * alias and never trimmed, so the `inReplyTo` filter applies the same
   * own-property exact match every bus read's `--in-reply-to` shares. Absent
   * when the body cites nothing through that field. */
  inReplyTo?: string;
}

export interface ConversationAgent { name: string; label: string; known: boolean; node: string | null }
/** Key order is the JSON contract. */
export interface ConversationItem {
  id: string; at: string; from: string; to: string; kind: AgentMessageKind; subject: string;
  /** The envelope priority band the message was stamped with; absent only when the source row carried none. */
  priority?: BusPriority;
  /** The body's own `inReplyTo` citation, verbatim — never the `replyTo` alias; absent when the body cites nothing through that field. */
  inReplyTo?: string;
}
/** Two agents that exchanged messages in this thread, for the map's line. */
export interface ConversationLink { a: string; b: string; count: number; lastAt: string }
export interface Conversation {
  id: string;
  participants: ConversationAgent[];
  subject: string;
  messageCount: number;
  lastAt: string;
  state: ConversationState;
  /** `state` in plain words. */
  stateText: string;
  /** Present only while waiting: who has to answer, since when, for how long. */
  waiting: { on: string; since: string; ms: number } | null;
  /** Every job id a member message names — a body citation, a reported job link or the `job:<id>` bucket itself; sorted, empty when the thread names none. */
  jobs: readonly string[];
  links: ConversationLink[];
  /** Oldest first. */
  messages: ConversationItem[];
}
export interface AgentConversations {
  schema: 'agents.conversations.v1';
  version: 1;
  generatedAt: string;
  source: 'available' | 'missing' | 'unavailable';
  /** Threads passing every filter, capped at the query's `limit` — the
   * same matched-before-limit convention `agent-messages.v1` reports;
   * null when the bus could not be read (unknown, not zero). */
  conversations: Conversation[] | null;
  /** Every thread the filters kept before `limit` cut the page; null when
   * `conversations` is null, the same unknown-stays-unknown rule. */
  matched: number | null;
  waiting: number | null;
  skipped: number;
}
export interface ConversationQuery {
  agent?: string; waitingOnly?: boolean; blockedOnly?: boolean; job?: string; waitingOn?: string;
  /** Keep only threads in this one state — the general form of the
   * `waitingOnly`/`blockedOnly` shortcuts, which stay conjunctive with it
   * (a thread cannot be two states, so contradictory filters are an honest
   * empty list). `answered` and `done` are the states no flag reached
   * before. */
  state?: ConversationState;
  /** Keep only threads whose last activity (`lastAt`) is at or after this
   * epoch-ms cutoff — the same inclusive `receivedAt >= since` rule
   * `phm messages --since` applies. Whole threads, never partial message
   * lists: a dormant thread whose newest message predates the cutoff drops
   * out even while it still waits, so pair it with `--waiting`/`--state`
   * when the question is "what is still outstanding", not "what moved". */
  since?: number;
  /** Keep only threads whose last activity (`lastAt`) is strictly before
   * this epoch-ms cutoff — the exclusive upper bound composing with `since`
   * into one `[since, before)` window, the same `receivedAt < before` rule
   * every other bus read's `--before` applies, so a thread stamped exactly
   * at the cutoff never matches and adjacent windows never double-count it.
   * Whole threads, never partial message lists: reaching a past slice of
   * the thread list no longer means paging forward through everything newer. */
  before?: number;
  /** Keep only threads where at least one member message's scrubbed
   * one-line `subject` carries the needle as a case-insensitive substring —
   * the same `--contains` text search `phm messages`, `agents bus inbox`
   * and `agents bus channel read` apply, over the same rendered summaries
   * those reads show (never the raw body, so a secret-shaped value stays
   * unfindable). Whitespace collapses on both sides; a needle that
   * normalizes to nothing imposes no constraint. Whole threads, never
   * partial message lists: the matched member stays in `messages[]`. */
  contains?: string;
  /** Keep only threads where at least one member message's body cites this
   * envelope id through its own `inReplyTo` field — the same own-property
   * exact match `phm messages --in-reply-to`, `agents bus inbox
   * --in-reply-to`, `agents bus channel read --in-reply-to`, `comms bus
   * read|watch --in-reply-to`, `fleet bus-follow --in-reply-to` and
   * `fleet_bus_inbox`'s `inReplyTo` apply, never the `replyTo` alias or a
   * substring — so "which thread is the answer to envelope X in" is one
   * filtered read. Whole threads, never partial message lists. */
  inReplyTo?: string;
  /** Keep only threads where at least one member message is addressed to
   * `group:<channel>:*` — the room's whole traffic under every topic, the
   * same raw `to`-prefix rule `phm messages --channel`, `agents bus inbox
   * --channel`, `channel read` and the work feed's `--channel` match — so
   * "which threads touch channel X" is one filtered read. Whole threads,
   * never partial message lists. */
  channel?: string;
  /** Keep only threads where at least one member message carries this exact
   * P0..P3 band — the same match every other bus read's `--priority`
   * applies; a member message with no recorded band names no provable band
   * and never matches. Whole threads, never partial message lists. */
  priority?: BusPriority;
  /** Keep only threads where at least one member message was sent under
   * this agent's labels — the same sender-inclusion rule every bus read's
   * `--from` applies: a handle, `agent:<handle>`, stable id or alias
   * matching every label of that identity, an unresolvable ref keeping
   * exact-label matching. Decided on each member message's `from`, so a
   * thread the agent only receives in never passes. Whole threads. */
  from?: string;
  /** Drop threads where any member message was sent under this agent's
   * labels — the sender-exclusion counterpart of `from`, composing so a
   * sender both included and excluded matches nothing, the same rule every
   * bus read's `--exclude-from` applies. Whole threads. */
  excludeFrom?: string;
  /** Cap the returned threads, newest order kept (longest-waiting first,
   * then newest); absent means every matched thread. `matched` still
   * reports the full filtered count. */
  limit?: number;
}

/** Whether a routing label is a known agent (the leader, a lane, a job, a lane's numbered agent; a topic is not) and its map node. */
export type PlaceAgent = (name: string, lane: string | null) => { known: boolean; node: string | null };

/** Pure: messages in, threads out. The same messages and clock always give the same JSON. `place` says whether a label is a known agent and which map node it is. */
export function groupConversations(messages: readonly ConversationMessage[], now: number, place: PlaceAgent): Conversation[] {
  const byId = new Map<string, ConversationMessage>();
  for (const m of messages) if (!byId.has(m.id)) byId.set(m.id, m);
  const rootOf = (m: ConversationMessage): string => {
    let at = m;
    // A reply to a message not on the bus, or a loop, ends the walk: that message starts the thread.
    for (let hops = 0; hops < 1000 && at.replyTo && at.replyTo !== at.id && byId.has(at.replyTo); hops++) at = byId.get(at.replyTo)!;
    return at.thread ?? at.id;
  };
  const threads = new Map<string, ConversationMessage[]>();
  for (const m of byId.values()) {
    const root = m.thread ?? rootOf(m);
    threads.set(root, [...(threads.get(root) ?? []), m]);
  }
  const lanes = new Map<string, string | null>();
  for (const m of byId.values()) if (m.lane) lanes.set(m.from, m.lane);
  const who = (name: string): ConversationAgent => {
    const at = place(name, lanes.get(name) ?? null);
    return { name, label: at.known ? name : UNKNOWN_AGENT, known: at.known, node: at.node };
  };
  const out: Conversation[] = [];
  for (const [id, list] of threads) {
    const items = [...list].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const last = items[items.length - 1]!;
    const names = [...new Set(items.flatMap(m => [m.from, m.to]))];
    const wantsReply = last.kind === 'ask' || last.kind === 'handoff';
    const state: ConversationState = last.kind === 'blocker' || last.state === 'blocked' ? 'blocked'
      : last.state === 'done' ? 'done' : wantsReply ? 'waiting'
      : last.kind === 'reply' || items.some(m => m.kind === 'ask' || m.kind === 'handoff') ? 'answered' : 'done';
    const jobs = new Set<string>();
    if (id.startsWith(JOB_BUCKET_PREFIX) && id.length > JOB_BUCKET_PREFIX.length) jobs.add(id.slice(JOB_BUCKET_PREFIX.length));
    for (const m of items) for (const job of m.jobIds ?? []) jobs.add(job);
    const links = new Map<string, ConversationLink>();
    for (const m of items) {
      const [a, b] = [m.from, m.to].sort() as [string, string], key = `${a}\u0000${b}`, link = links.get(key);
      if (link) { link.count++; link.lastAt = new Date(m.at).toISOString(); } else links.set(key, { a, b, count: 1, lastAt: new Date(m.at).toISOString() });
    }
    out.push({
      id, participants: names.map(who), subject: last.subject, messageCount: items.length, lastAt: new Date(last.at).toISOString(),
      state, stateText: CONVERSATION_STATE_WORDS[state],
      waiting: state === 'waiting' ? { on: last.to, since: new Date(last.at).toISOString(), ms: Math.max(0, now - last.at) } : null,
      jobs: [...jobs].sort(),
      links: [...links.values()],
      messages: items.map(m => ({ id: m.id, at: new Date(m.at).toISOString(), from: m.from, to: m.to, kind: m.kind, subject: m.subject,
        ...(m.priority === undefined ? {} : { priority: m.priority }),
        ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }) })),
    });
  }
  return out.sort((a, b) => (b.waiting?.ms ?? -1) - (a.waiting?.ms ?? -1) || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.id < b.id ? -1 : 1));
}

/**
 * One agent (by name), waiting threads only, blocked threads only, one state
 * (`state`), and/or one job:
 * `job` keeps the threads the projection ties to that id — the `job:<id>` bucket itself or a
 * member message naming it — whole threads, never partial message lists. With
 * `identityOf`, a participant also matches when its label and the query
 * resolve to the same registered identity, so one agent's handle, alias and
 * address never split the filter; an unresolvable side changes nothing. The
 * query agent resolves its key through `refKeyFor` when the read supplies
 * it — exact `resolveAgent` semantics, so a case-variant or otherwise
 * unregistered spelling never inherits an identity's label set — while
 * participant labels keep folding through `identityOf`; a caller passing
 * only `identityOf` keeps the historical fold on both sides.
 * `waitingOn` keeps the waiting threads one agent owes a reply on: only a
 * `state:'waiting'` thread whose `waiting.on` the caller's `waitingOnMatch`
 * predicate accepts for its latest sender qualifies — `readAgentConversations`
 * builds that predicate from the identity registry (the agent's own labels,
 * names resolving to its identity, `group:<channel>:<topic>` addresses of
 * channels it belongs to, minus threads whose waiting message the agent
 * itself sent), so an unresolvable ref or unreadable registry keeps the
 * literal `waiting.on` match and never widens. Without a predicate only the
 * literal `waiting.on` label matches. `since` keeps only the threads whose
 * `lastAt` reaches the epoch-ms cutoff — activity inside the window, whole
 * threads like every other filter here. `before` keeps only the threads
 * whose `lastAt` is strictly before its own epoch-ms cutoff — the exclusive
 * upper bound `since` composes with into one `[since, before)` window — and
 * an inverted or empty window is an honest empty list, never an error.
 * `contains` keeps only the threads
 * where at least one member message's scrubbed `subject` carries the needle
 * — the same text-search contract `phm messages --contains` applies — so
 * "which thread is about X" is one filtered read. `inReplyTo` keeps only
 * the threads where at least one member message's body cites that envelope
 * id through its own `inReplyTo` field — the same own-property exact match
 * every bus read's `--in-reply-to` applies, never the `replyTo` alias or a
 * substring. `channel` keeps only the threads where at least one member
 * message is addressed to `group:<channel>:*` — the same raw `to`-prefix
 * rule every bus read's `--channel` matches. `priority` keeps only the
 * threads where at least one member message carries that exact P0..P3 band
 * — a member with no recorded band never matches. `from` keeps only the
 * threads where at least one member message was sent under the ref's
 * labels — the same sender-inclusion rule every bus read's `--from`
 * applies, decided on each member's `from` through the same
 * name/lane/identity-key match `agent` uses, so a thread the ref only
 * receives in never passes; `excludeFrom` drops every thread where any
 * member message was sent under that ref's labels, composing with `from`
 * so a sender both included and excluded matches nothing. Every one of
 * these is a member-level test: whole threads survive, never partial
 * message lists, and the matched member stays in `messages[]`.
 */
export function filterConversations(list: readonly Conversation[], query: ConversationQuery,
  identityOf?: AgentIdentityKeyFor, waitingOnMatch?: (on: string, from: string) => boolean,
  refKeyFor?: AgentIdentityKeyFor): Conversation[] {
  const agent = query.agent?.toLowerCase();
  const keyFor = refKeyFor ?? identityOf;
  const key = agent !== undefined ? keyFor?.(query.agent!) : undefined;
  const owed = query.waitingOn?.toLowerCase();
  const from = query.from?.toLowerCase();
  const fromKey = from !== undefined ? keyFor?.(query.from!) : undefined;
  const excludeFrom = query.excludeFrom?.toLowerCase();
  const excludeKey = excludeFrom !== undefined ? keyFor?.(query.excludeFrom!) : undefined;
  // --contains normalizes once per read — lowercase, whitespace collapsed,
  // trimmed — the same needle form every other bus read's --contains applies;
  // a needle that normalizes to nothing imposes no constraint.
  const needle = query.contains?.toLowerCase().replace(/\s+/g, ' ').trim();
  const mentions = (c: Conversation): boolean => needle === undefined || needle === '' ||
    c.messages.some(m => m.subject.toLowerCase().replace(/\s+/g, ' ').includes(needle));
  // The sender filters decide on each member message's `from` label through
  // the same name/identity-key match the `agent` participant filter applies:
  // the literal label always matches, and any label resolving to the ref's
  // identity key matches too; an unresolvable side changes nothing.
  const senderIs = (wanted: string, wantedKey: string | undefined) => (name: string): boolean =>
    name.toLowerCase() === wanted || (wantedKey !== undefined && identityOf?.(name) === wantedKey);
  const fromMatch = from === undefined ? undefined : senderIs(from, fromKey);
  const excludeMatch = excludeFrom === undefined ? undefined : senderIs(excludeFrom, excludeKey);
  const channelPrefix = query.channel === undefined ? undefined : `group:${query.channel}:`;
  return list.filter(c => (query.job === undefined || c.jobs.includes(query.job))
    && (query.since === undefined || Date.parse(c.lastAt) >= query.since)
    && (query.before === undefined || Date.parse(c.lastAt) < query.before)
    && mentions(c)
    && (query.inReplyTo === undefined || c.messages.some(m => m.inReplyTo === query.inReplyTo))
    && (channelPrefix === undefined || c.messages.some(m => m.to.startsWith(channelPrefix)))
    && (query.priority === undefined || c.messages.some(m => m.priority === query.priority))
    && (fromMatch === undefined || c.messages.some(m => fromMatch(m.from)))
    && (excludeMatch === undefined || !c.messages.some(m => excludeMatch(m.from)))
    && (!agent || c.participants.some(p => p.name.toLowerCase() === agent
      || (key !== undefined && identityOf?.(p.name) === key)))
    && (!query.waitingOnly || c.state === 'waiting')
    && (!query.blockedOnly || c.state === 'blocked')
    && (query.state === undefined || c.state === query.state)
    && (query.waitingOn === undefined || (c.waiting !== null && (
      waitingOnMatch !== undefined
        ? waitingOnMatch(c.waiting.on, c.messages[c.messages.length - 1]?.from ?? '')
        : c.waiting.on.toLowerCase() === owed))));
}

/** `3m`, `2h 5m`, `1d 4h`: one plain duration. */
export function plainAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under 1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

