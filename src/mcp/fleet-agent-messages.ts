/**
 * `fleet_agent_messages` MCP adapter: the fleet-wide agent-to-agent message
 * timeline — `readAgentMessages`, the same `agent-messages.v1` read
 * `phm messages`, GET /api/verse/agent-bus/messages and the desktop
 * Messages/Org panes serve. `fleet_agent_inbox` answers one agent's
 * addressed mail, `fleet_bus_channel` one room's transcript and
 * `fleet_bus_inbox` the raw store page; none lists every classified
 * agent-to-agent message newest-first with its conversation, job and pr
 * links in one read.
 *
 * Every argument is optional and takes the same value rules the
 * `phm messages` flags and the API params share, all validated before any
 * store read: `since` the shared 15m/2h/1d/epoch-ms/ISO grammar resolved
 * to a safe non-negative epoch-ms integer and `before` the same grammar
 * as the exclusive upper bound composing with `since` into one
 * [since, before) window, `agent`/`with`/`job`/`thread`/
 * `from`/`excludeFrom`/`inReplyTo`/`id` printable routing labels (`with` narrows
 * `agent` to the two-way talk between that agent and one other and
 * requires `agent`), `kind` one of ask/reply/handoff/status/blocker under
 * the CLI's case-insensitive match, `priority` one exact P0–P3 band,
 * `channel` the strict channel-name grammar, `contains` the bounded needle
 * `busReadContains` normalizes and `limit` an integer in 1–1024 (the
 * projection's own default of 50 applies when absent). Unknown keys,
 * wrong types, caller roots and malformed values are all refused before
 * the store is touched.
 *
 * The result is the projection untouched plus the MCP envelope metadata:
 * `source` keeps missing/unavailable honest — an unreadable store is
 * never an invented empty timeline — `matched` always reports the true
 * filtered total before the `limit` cap, `skipped` counts damaged bus
 * rows, and `jobState` feed evidence on job-citing bodies degrades to
 * unavailable rather than a guessed job. Read-only: routing labels are
 * data, never authenticated identity; no caller root, path or cwd is
 * accepted — the store, registry, hold table and feed roots stay
 * server-owned — and the tool never posts, claims, acks, replies or
 * renews TTL.
 */
import {
  AGENT_MESSAGE_KINDS, AGENT_MESSAGES_MAX_LIMIT,
  parseSince, readAgentMessages,
  type AgentMessageKind, type AgentMessages, type AgentMessagesQuery,
} from '../core/fleet/agent-messages.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { busReadContains } from '../core/agents/bus-unified.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';

/** The printable-label rule `agent`, `with`, `job`, `thread`, `from`, `excludeFrom`, `inReplyTo` and `id` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const MESSAGE_KEYS = new Set([
  'since', 'before', 'agent', 'with', 'kind', 'priority', 'job', 'thread',
  'contains', 'from', 'excludeFrom', 'inReplyTo', 'channel', 'id', 'limit',
]);
const LABEL_KEYS = ['job', 'thread', 'from', 'excludeFrom', 'inReplyTo', 'id'] as const;

/** The parsed arguments are the projection's own query — the MCP surface adds no filter the CLI/API do not share. */
export type FleetAgentMessagesArgs = AgentMessagesQuery;

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every key
 * is optional — the timeline has no required agent — and each takes the
 * same value rules `parseAgentMessagesQuery` enforces for the CLI flags
 * and API params: `kind` lowercases into the classified-kind enum,
 * `priority` stays an exact P0–P3 member, the label keys and `channel`
 * take their grammar, `since`/`before` resolve through `parseSince` to a
 * safe non-negative epoch-ms integer (`before` the exclusive upper bound
 * composing with `since` into one [since, before) window), `contains`
 * normalizes through
 * `busReadContains` and `limit` stays inside the projection's bound.
 * `with` without `agent` is refused exactly as `--with` without `--agent`
 * is. Unknown keys, wrong types, caller roots and malformed values are
 * all refused before the store is touched.
 */
export function parseFleetAgentMessagesArgs(args: Record<string, unknown>): FleetAgentMessagesArgs | null {
  if (Object.keys(args).some(key => !MESSAGE_KEYS.has(key))) return null;
  const query: AgentMessagesQuery = {};

  const kind = args.kind;
  if (kind !== undefined) {
    if (typeof kind !== 'string') return null;
    const normalized = kind.toLowerCase();
    if (!(AGENT_MESSAGE_KINDS as readonly string[]).includes(normalized)) return null;
    query.kind = normalized as AgentMessageKind;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    query.priority = priority as BusPriority;
  }
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    query[key] = value;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    query.channel = channel;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) query.contains = contains;
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    query.since = resolved;
  }
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    query.before = resolved;
  }
  const agent = args.agent;
  if (agent !== undefined) {
    if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;
    query.agent = agent;
  }
  const withAgent = args.with;
  if (withAgent !== undefined) {
    if (query.agent === undefined || typeof withAgent !== 'string' || !BUS_LABEL.test(withAgent)) return null;
    query.with = withAgent;
  }
  const limit = args.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > AGENT_MESSAGES_MAX_LIMIT) {
      return null;
    }
    query.limit = limit;
  }
  return query;
}

export interface FleetAgentMessagesDeps {
  read?: typeof readAgentMessages;
}

export type FleetAgentMessagesResult = AgentMessages & {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
};

/**
 * One timeline page through the shared `readAgentMessages` projection —
 * the identical read `phm messages` and the API endpoint run, so
 * classification, conversation grouping, identity-label matching,
 * row-level thread/channel filtering, `matched`/`skipped` honesty and
 * job feed-state annotation can never diverge between the CLI, the API,
 * the desktop panes and this tool. The projection's `source`,
 * `messages`, `matched` and `skipped` pass through untouched — a missing
 * or unreadable store stays `missing`/`unavailable`, never an invented
 * empty timeline — under the standard MCP envelope metadata.
 */
export async function readFleetAgentMessages(
  args: FleetAgentMessagesArgs,
  deps: FleetAgentMessagesDeps = {},
): Promise<FleetAgentMessagesResult> {
  const read = deps.read ?? readAgentMessages;
  const result: AgentMessages = read(args);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
