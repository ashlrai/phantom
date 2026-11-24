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
  /** The body's own kind discriminator — the same `busBodyKind` read every
   * bus read's body-kind filter applies: the v2 `kind` (`note`, `context`,
   * `work.post`, `work.claim`, `work.status`, `work.result`, `work.release`,
   * `wake`), a `worker-handoff` or notice kind, a bus-transport v1
   * `protocol.kind`, else the `type`/`schema` a kindless notice keys on.
   * Absent when the body carries none, so it never matches a `bodyKind`
   * filter — the same "unknown stays out" rule every other own-field filter
   * keeps. */
  bodyKind?: string;
}

export interface ConversationAgent { name: string; label: string; known: boolean; node: string | null }
/** Key order is the JSON contract. */
export interface ConversationItem {
  id: string; at: string; from: string; to: string; kind: AgentMessageKind; subject: string;
  /** The envelope priority band the message was stamped with; absent only when the source row carried none. */
  priority?: BusPriority;
  /** The body's own `inReplyTo` citation, verbatim — never the `replyTo` alias; absent when the body cites nothing through that field. */
  inReplyTo?: string;
  /** The member's declared conversation bucket — a thread label, `threadId`, `job:<id>` or origin key — verbatim; absent when the message declared none and joined its thread by reply chain alone, so it never matches a `thread` filter. */
  thread?: string;
  /** The member's body kind discriminator, verbatim — the same `busBodyKind` field the thread-level `bodyKind` filter reads; absent when the body carries none. */
  bodyKind?: string;
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
  /** Keep only the thread envelope `id` belongs to — at most one thread,
   * since every member message sits in exactly one — decided on each
   * member message's own wire id strictly equal to the value, the same
   * exact-envelope match every other bus read's `--id` applies
   * (`phm messages --id`, `agents bus inbox`/`channel read --id`,
   * `agents bus wakes --id`, `comms bus read|watch --id`, `fleet
   * bus-follow --id`, `fleet_bus_inbox`'s `id`), never a substring or a
   * thread-key or body citation — so "which thread is envelope X in" is
   * one filtered read returning the whole thread, where `phm messages
   * --id` reports only the one row. A declared thread bucket (`job:<id>`,
   * a thread label) is no member id and never matches; an id nothing on
   * the bus carries is an honest empty list. Whole threads, never
   * partial message lists. */
  id?: string;
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
  /** Keep only threads holding the two-way exchange `agent` and `with` name
   * — the same pairwise rule `phm messages --agent <a> --with <b>` applies,
   * decided on each member message's from/to endpoints: a member counts when
   * one endpoint is the `agent` ref and the other the `with` ref, in either
   * direction, each side matching by the same name/identity-key rule the
   * `agent` participant filter and the `from`/`excludeFrom` sender filters
   * use, so a thread where the two only ever talk through a third party or a
   * room never passes. `with` narrows `agent` and means nothing without it:
   * a `with` with no `agent` is an honest empty list, never a widened one —
   * the same needs-`--agent` rule the messages read enforces. Whole threads,
   * never partial message lists. */
  with?: string;
  /** Keep only threads where at least one member message declared this exact
   * conversation bucket — a thread label, `threadId`, `job:<id>` or origin
   * key, the same declared-key space the projection groups on — strictly
   * equal to the value, never a substring or a reply-chain root: an
   * undeclared chain whose members carry no bucket names no provable thread
   * and never matches (its root envelope id is `--id`'s match, not this
   * one's). The same exact own-field rule every bus read's `--thread`
   * applies — `phm messages --thread`, `agents bus inbox --thread`,
   * `channel read --thread` and `agents bus wakes --thread` — so "the
   * conversation labelled X" is one filtered read. Whole threads, never
   * partial message lists. */
  thread?: string;
  /** Keep only threads where at least one member message's body carries this
   * exact kind discriminator — the same `busBodyKind` field and own-field
   * exact match every bus read's body-kind filter applies (`agents bus
   * inbox --body-kind`, `channel read --body-kind`, `agents bus wakes
   * --body-kind`): the v2 `kind` (`note`, `context`, `work.post`,
   * `work.claim`, `work.status`, `work.result`, `work.release`, `wake`), a
   * `worker-handoff` or notice kind, a bus-transport v1 `protocol.kind`,
   * else the `type`/`schema` a kindless notice keys on. A member message
   * whose body carries no discriminator names no provable kind and never
   * matches. Whole threads, never partial message lists. */
  bodyKind?: string;
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
        ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
        ...(m.thread === null || m.thread === undefined ? {} : { thread: m.thread }),
        ...(m.bodyKind === undefined ? {} : { bodyKind: m.bodyKind }) })),
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
 * substring. `id` keeps only the thread one member message's own wire id
 * strictly equals — at most one thread, since every member sits in exactly
 * one — the same exact-envelope match every bus read's `--id` applies,
 * never a substring or a thread-key or body citation, so "which thread is
 * envelope X in" is one filtered read returning the whole thread where
 * `phm messages --id` reports only the row. `channel` keeps only the
 * threads where at least one member
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
 * so a sender both included and excluded matches nothing. `with` keeps
 * only the threads holding the two-way exchange `agent` and the `with`
 * ref name — the same pairwise rule `phm messages --agent <a> --with
 * <b>` applies, decided on each member message's from/to endpoints (one
 * endpoint the `agent` ref, the other the `with` ref, either direction,
 * each side through the same name/identity-key match) — so "our thread"
 * is one filtered read while a thread where the two only share a third
 * party or a room never passes; a `with` with no `agent` is an honest
 * empty list, never a widened one. `thread` keeps only the threads where
 * at least one member message declared that exact conversation bucket —
 * the same declared-key space the projection groups on (a thread label,
 * `threadId`, `job:<id>` or origin key), strictly equal, never a
 * substring — so "the conversation labelled X" is one filtered read
 * while an undeclared reply chain, whose members carry no bucket, names
 * no provable thread and never matches (its root envelope id stays
 * `--id`'s match). `bodyKind` keeps only the threads where at least one
 * member message's body carries that exact kind discriminator — the
 * same `busBodyKind` own-field exact match every bus read's body-kind
 * filter applies — so "which threads carry work.post traffic" is one
 * filtered read. Every one of
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
  const peer = query.with?.toLowerCase();
  const peerKey = peer !== undefined ? keyFor?.(query.with!) : undefined;
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
  // `with` narrows `agent` to the threads holding the pairwise exchange —
  // the same from/to endpoint test `phm messages --with` applies, run over
  // each member message's labels through the same sender matcher. A `with`
  // with no `agent` proves nothing and matches nothing.
  const agentMatch = agent === undefined ? undefined : senderIs(agent, key);
  const peerMatch = peer === undefined ? undefined : senderIs(peer, peerKey);
  const pairwise = peer === undefined ? undefined
    : agentMatch === undefined || peerMatch === undefined ? () => false
    : (c: Conversation) => c.messages.some(m =>
      (agentMatch(m.from) && peerMatch(m.to)) || (peerMatch(m.from) && agentMatch(m.to)));
  const channelPrefix = query.channel === undefined ? undefined : `group:${query.channel}:`;
  return list.filter(c => (query.job === undefined || c.jobs.includes(query.job))
    && (query.since === undefined || Date.parse(c.lastAt) >= query.since)
    && (query.before === undefined || Date.parse(c.lastAt) < query.before)
    && mentions(c)
    && (query.inReplyTo === undefined || c.messages.some(m => m.inReplyTo === query.inReplyTo))
    && (query.id === undefined || c.messages.some(m => m.id === query.id))
    && (query.thread === undefined || c.messages.some(m => m.thread === query.thread))
    && (query.bodyKind === undefined || c.messages.some(m => m.bodyKind === query.bodyKind))
    && (channelPrefix === undefined || c.messages.some(m => m.to.startsWith(channelPrefix)))
    && (query.priority === undefined || c.messages.some(m => m.priority === query.priority))
    && (fromMatch === undefined || c.messages.some(m => fromMatch(m.from)))
    && (excludeMatch === undefined || !c.messages.some(m => excludeMatch(m.from)))
    && (pairwise === undefined || pairwise(c))
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

