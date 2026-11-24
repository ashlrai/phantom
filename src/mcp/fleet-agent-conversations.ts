/**
 * `fleet_agent_conversations` MCP adapter: the shared agent-to-agent
 * conversation projection — `readAgentConversations`, the same
 * `agents.conversations.v1` read `phm agents conversations` and
 * GET /api/verse/fleet/control/agent-conversations serve. Every other bus
 * tool answers a slice — `fleet_agent_inbox` one agent's addressed mail,
 * `fleet_agent_messages` the flat newest-first timeline, `fleet_agent_work`
 * one agent's pending digest — but none answers the grouped question an
 * off-host agent actually asks: "which threads are agents waiting on each
 * other in, who owes whom a reply, which thread is blocked or done, and
 * what moved lately" — without shelling out to `phm` and regrouping raw
 * messages itself.
 *
 * Every argument is optional and takes the same value rules the
 * `phm agents conversations` flags and the API params share, all validated
 * before any store read: `agent`, `job`, `waitingOn`, `with`, `inReplyTo`,
 * `id`, `from` and `excludeFrom` printable routing
 * labels (`agent` keeps threads that identity is in, resolved through the
 * server-owned registry; `waitingOn` keeps the waiting threads one agent
 * owes a reply on — its own labels or a `group:<channel>:<topic>` address
 * of a channel it belongs to, never a thread whose waiting message the
 * agent itself sent; `with` narrows `agent` to the threads holding the
 * two-way exchange between the two named agents — the same pairwise rule
 * `phm messages --agent <a> --with <b>` applies, decided on each member
 * message's from/to endpoints in either direction — and means nothing
 * without `agent`, which is refused the same way the CLI and the API
 * refuse it), `waiting`/`blocked` JSON booleans for the
 * `--waiting`/`--blocked`/`?waiting=1`/`?blocked=1` shortcuts (`false` is
 * the same as absent), `state` one of waiting/answered/blocked/done — the
 * general form of the two booleans, which stay conjunctive with it so a
 * contradictory pair is an honest empty list — `since` the shared
 * 15m/2h/1d/epoch-ms/ISO grammar resolved to a safe non-negative
 * epoch-ms integer (threads whose last activity reaches the cutoff, whole
 * threads never partial message lists), `before` the same grammar as the
 * exclusive upper bound composing with `since` into one `[since, before)`
 * window on last activity, `contains` the bounded needle
 * `busReadContains` normalizes over each member message's scrubbed
 * one-line subject — never the raw body — and `limit` an integer in
 * 1–1024. Unknown keys, wrong types, caller roots and malformed values
 * are all refused before the store is touched.
 *
 * The result is the projection untouched plus the MCP envelope metadata:
 * `source` keeps missing/unavailable honest — an unreadable store or
 * registry leaves `conversations`, `matched` and `waiting` null, never an
 * invented empty thread list — `matched` reports every thread the filters
 * kept before `limit` cut the page, `waiting` counts the unfiltered
 * waiting threads, `skipped` counts damaged bus rows, and each thread
 * reports its participants, scrubbed subject, message count, last
 * activity, state, waiting detail, job links, cross-links and member
 * messages. Read-only: routing labels are data, never authenticated
 * identity; no caller root, path or cwd is accepted — the store and
 * registry roots stay server-owned — and the tool never posts, claims,
 * acks, replies or writes.
 */
import { busReadContains } from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import {
  CONVERSATION_STATES, readAgentConversations,
  type AgentConversations, type ConversationQuery, type ConversationState,
} from '../core/fleet/agent-conversations.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** The printable-label rule `agent`, `job`, `waitingOn`, `inReplyTo`, `id`, `from`, `excludeFrom` and `with` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const CONVERSATION_KEYS = new Set([
  'agent', 'waiting', 'blocked', 'state', 'job', 'waitingOn', 'since', 'before', 'contains',
  'inReplyTo', 'id', 'channel', 'priority', 'from', 'excludeFrom', 'with', 'limit',
]);
const LABEL_KEYS = ['agent', 'job', 'waitingOn', 'inReplyTo', 'id', 'from', 'excludeFrom', 'with'] as const;
/** The same page cap `phm agents conversations --limit` and the API param share. */
const CONVERSATIONS_LIMIT_MAX = 1024;

export interface FleetAgentConversationsArgs {
  /** Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias — resolved through the server-side registry; keeps the threads that identity is in. */
  agent?: string;
  /** Keep only threads waiting for a reply — the `--waiting`/`?waiting=1` rule. */
  waiting?: boolean;
  /** Keep only threads a blocker or failed report left unanswered — the `--blocked`/`?blocked=1` rule. */
  blocked?: boolean;
  /** Keep only threads in one state — the general form of `waiting`/`blocked`, conjunctive with them. */
  state?: ConversationState;
  /** Keep only threads that name this job id — its `job:<id>` bucket or a member message citing it. */
  job?: string;
  /** Keep only the waiting threads this agent owes a reply on — its own labels or a channel address it belongs to, never a thread it is itself waiting on. */
  waitingOn?: string;
  /** Keep only threads whose last activity is at or after this epoch-ms cutoff — the shared `since` grammar resolved once. */
  since?: number;
  /** Keep only threads whose last activity is strictly before this epoch-ms cutoff — the exclusive upper bound composing with `since` into one `[since, before)` window. */
  before?: number;
  /** Keep only threads where at least one member message's scrubbed one-line subject carries this needle — the shared `--contains` rule. */
  contains?: string;
  /** Keep only threads where at least one member message's body cites this envelope id through its own `inReplyTo` field — the shared `--in-reply-to` rule. */
  inReplyTo?: string;
  /** Keep only the thread one member message's own wire id strictly equals — at most one thread — the shared `--id` rule. */
  id?: string;
  /** Keep only threads where at least one member message is addressed to `group:<channel>:*` — the shared `--channel` rule. */
  channel?: string;
  /** Keep only threads where at least one member message carries this exact P0..P3 band — the shared `--priority` rule. */
  priority?: BusPriority;
  /** Keep only threads where at least one member message was sent under this agent's labels — the shared `--from` rule. */
  from?: string;
  /** Drop threads where any member message was sent under this agent's labels — the shared `--exclude-from` rule. */
  excludeFrom?: string;
  /** Keep only threads holding the two-way exchange `agent` and this agent name — the shared `--with` rule; needs `agent`, refused without it. */
  with?: string;
  /** Cap the returned threads, longest-waiting order kept; `matched` still reports the full filtered count. */
  limit?: number;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every key
 * is optional — the thread list has no required agent — and each takes
 * the same value rules `phm agents conversations` flags and the API
 * params share: the label keys printable routing labels, `waiting`/
 * `blocked` JSON booleans (`false` is the same as absent), `state` one
 * exact CONVERSATION_STATES member, `with` a printable routing label that
 * needs `agent` — the same needs-`--agent` rule the CLI flag and the
 * `phm messages --with` read share — `since`/`before` the shared
 * `15m`/`2h`/`1d`/epoch-ms/ISO grammar resolved to a safe non-negative
 * epoch-ms integer — `before` the exclusive upper bound composing with
 * `since` into one `[since, before)` window on last activity —
 * `contains` the bounded free-text needle
 * `busReadContains` normalizes and `limit` an integer in 1–1024.
 * Unknown keys, wrong types, caller roots and malformed values are all
 * refused before the store is touched.
 */
export function parseFleetAgentConversationsArgs(args: Record<string, unknown>): FleetAgentConversationsArgs | null {
  if (Object.keys(args).some(key => !CONVERSATION_KEYS.has(key))) return null;
  const parsed: FleetAgentConversationsArgs = {};
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    parsed[key] = value;
  }
  if (parsed.with !== undefined && parsed.agent === undefined) return null;
  for (const key of ['waiting', 'blocked'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return null;
    if (value) parsed[key] = true;
  }
  const state = args.state;
  if (state !== undefined) {
    if (typeof state !== 'string' || !(CONVERSATION_STATES as readonly string[]).includes(state)) return null;
    parsed.state = state as ConversationState;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) parsed.contains = contains;
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    parsed.channel = channel;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    parsed.priority = priority as BusPriority;
  }
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    parsed.since = resolved;
  }
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    parsed.before = resolved;
  }
  const limit = args.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > CONVERSATIONS_LIMIT_MAX) return null;
    parsed.limit = limit;
  }
  return parsed;
}

export interface FleetAgentConversationsDeps {
  read?: typeof readAgentConversations;
}

export type FleetAgentConversationsResult = AgentConversations & {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
};

/**
 * One conversation page through the shared `readAgentConversations`
 * projection — the identical read `phm agents conversations` and the API
 * endpoint run, so reply-chain grouping, identity-label matching,
 * waiting-on scope, per-filter semantics, `matched`/`waiting`/`skipped`
 * honesty and unavailable-source nulls can never diverge between the
 * CLI, the API and this tool. `waiting`/`blocked` map to the query's
 * `waitingOnly`/`blockedOnly` exactly as `--waiting`/`?waiting=1` do.
 * The projection's `source`, `conversations`, `matched`, `waiting` and
 * `skipped` pass through untouched — a missing or unreadable store or
 * registry stays `missing`/`unavailable` with null counts, never an
 * invented empty thread list — under the standard MCP envelope metadata.
 */
export async function readFleetAgentConversations(
  args: FleetAgentConversationsArgs,
  deps: FleetAgentConversationsDeps = {},
): Promise<FleetAgentConversationsResult> {
  const read = deps.read ?? readAgentConversations;
  const query: ConversationQuery = {
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.waiting === true ? { waitingOnly: true } : {}),
    ...(args.blocked === true ? { blockedOnly: true } : {}),
    ...(args.state === undefined ? {} : { state: args.state }),
    ...(args.job === undefined ? {} : { job: args.job }),
    ...(args.waitingOn === undefined ? {} : { waitingOn: args.waitingOn }),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.before === undefined ? {} : { before: args.before }),
    ...(args.contains === undefined ? {} : { contains: args.contains }),
    ...(args.inReplyTo === undefined ? {} : { inReplyTo: args.inReplyTo }),
    ...(args.id === undefined ? {} : { id: args.id }),
    ...(args.channel === undefined ? {} : { channel: args.channel }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.excludeFrom === undefined ? {} : { excludeFrom: args.excludeFrom }),
    ...(args.with === undefined ? {} : { with: args.with }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
  const result: AgentConversations = read(query);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    ...result,
  };
}
