/**
 * Pure thread model for agent-to-agent messages (no bus, no Node imports, so the
 * web UI can share it). See agent-conversations.ts for the bus read.
 */
import type { AgentMessageKind } from './agent-messages.js';
import type { AgentIdentityKeyFor } from '../agents/bus-identity.js';

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
}

export interface ConversationAgent { name: string; label: string; known: boolean; node: string | null }
/** Key order is the JSON contract. */
export interface ConversationItem { id: string; at: string; from: string; to: string; kind: AgentMessageKind; subject: string }
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
      messages: items.map(m => ({ id: m.id, at: new Date(m.at).toISOString(), from: m.from, to: m.to, kind: m.kind, subject: m.subject })),
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
 * address never split the filter; an unresolvable side changes nothing.
 * `waitingOn` keeps the waiting threads one agent owes a reply on: only a
 * `state:'waiting'` thread whose `waiting.on` the caller's `waitingOnMatch`
 * predicate accepts for its latest sender qualifies — `readAgentConversations`
 * builds that predicate from the identity registry (the agent's own labels,
 * names resolving to its identity, `group:<channel>:<topic>` addresses of
 * channels it belongs to, minus threads whose waiting message the agent
 * itself sent), so an unresolvable ref or unreadable registry keeps the
 * literal `waiting.on` match and never widens. Without a predicate only the
 * literal `waiting.on` label matches.
 */
export function filterConversations(list: readonly Conversation[], query: ConversationQuery,
  identityOf?: AgentIdentityKeyFor, waitingOnMatch?: (on: string, from: string) => boolean): Conversation[] {
  const agent = query.agent?.toLowerCase();
  const key = agent !== undefined && identityOf ? identityOf(query.agent!) : undefined;
  const owed = query.waitingOn?.toLowerCase();
  return list.filter(c => (query.job === undefined || c.jobs.includes(query.job))
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

