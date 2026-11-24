/**
 * `fleet_bus_channel` MCP adapter: the agent-bus channel transcript —
 * `readAgentChannel`, the same read `phm agents bus channel read` serves.
 * `fleet_bus_inbox` pages the raw durable store by routing label; this tool
 * answers "what did the room say" with the projection's own semantics:
 * `group:<channel>:*` addressing, `group.presence` heartbeats excluded,
 * per-row topic derivation, identity-label sender matching, the resolved
 * sender handle, live `held`/`holder` hold evidence and the `job`
 * feed-state annotation — none of which the raw page computes, and
 * `fleet_agent_inbox`'s `channel` filter only narrows one agent's
 * addressed mail, never the room transcript.
 *
 * Every filter validates before any store read and maps onto the same page
 * fields the CLI flags fill, so an MCP client can never disagree with the
 * CLI about what a value means; `channel` and `topic` take the channel-name
 * grammar the group address shares, and a name no registry channel carries
 * answers `unknown-channel`, never a guessed match. Read-only: no caller
 * root, path or cwd is accepted — the store, registry, hold table and feed
 * roots stay server-owned — and the tool never posts, claims, acks or
 * renews TTL. Routing labels are data, never authenticated identity;
 * reading needs no identity and no membership (membership gates posting
 * only), and an unreadable store or registry stays `unavailable`/`retryable`
 * while `held`/`job` stay null or unknown — never an empty transcript or
 * proven-free work passed off as history.
 */
import {
  busPageResumeCursor, busReadContains, readAgentChannel,
  type ChannelReadMessage, type ChannelReadPage,
} from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_INBOX_MAX_READ } from '../core/fleet/bus-inbox.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** Largest `limit` the tool accepts — the shared inbox page bound the CLI read uses too. */
export const FLEET_BUS_CHANNEL_LIMIT_MAX = BUS_INBOX_MAX_READ;
export const FLEET_BUS_CHANNEL_LIMIT_DEFAULT = 50;

/** The printable-label rule `from`, `excludeFrom`, `thread`, `job`, `inReplyTo` and `id` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const CHANNEL_KEYS = new Set([
  'channel', 'topic', 'after', 'limit', 'matched',
  'from', 'excludeFrom', 'thread', 'priority', 'job', 'since', 'before', 'contains', 'inReplyTo', 'id',
]);
const LABEL_KEYS = ['from', 'excludeFrom', 'thread', 'job', 'inReplyTo', 'id'] as const;

/** The `readAgentChannel` page fields the MCP arguments fill — `after`, `limit` and `matched` ride beside them. */
export interface FleetBusChannelFilters {
  topic?: string;
  from?: string;
  excludeFrom?: string;
  thread?: string;
  priority?: BusPriority;
  job?: string;
  since?: number;
  before?: number;
  contains?: string;
  inReplyTo?: string;
  id?: string;
}

export interface FleetBusChannelArgs {
  /** Registry channel name — the `group:<channel>:*` room the transcript covers. */
  channel: string;
  /** Persisted cursor; rows at or below it are already handled. */
  after: number;
  /** Cap on returned rows after filtering. */
  limit: number;
  /** Also report `matched`, the true filtered total across the whole retained store. */
  matched: boolean;
  filters: FleetBusChannelFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `channel`
 * is required — the transcript has no meaningful default — and every other
 * key takes the same value rules `phm agents bus channel read` flags and
 * the other bus reads share: the channel-name grammar for `channel`/`topic`
 * (the group address's own namespace rule), printable routing labels
 * (`id` the exact-envelope match),
 * the P0–P3 priority enum, the shared `since` grammar and the bounded
 * `contains` needle normalized by `busReadContains`. Unknown keys, wrong
 * types, caller roots and malformed values are all refused before the
 * store is touched.
 */
export function parseFleetBusChannelArgs(args: Record<string, unknown>): FleetBusChannelArgs | null {
  if (Object.keys(args).some(key => !CHANNEL_KEYS.has(key))) return null;
  const channel = args.channel;
  if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
  const topic = args.topic;
  if (topic !== undefined && (typeof topic !== 'string' || !agentChannelNameSchema.safeParse(topic).success)) {
    return null;
  }
  const after = args.after ?? 0;
  if (args.after === null || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return null;
  const limit = args.limit === undefined && !('limit' in args) ? FLEET_BUS_CHANNEL_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_BUS_CHANNEL_LIMIT_MAX) return null;
  const matched = args.matched === undefined ? false : args.matched;
  if (typeof matched !== 'boolean') return null;

  const filters: FleetBusChannelFilters = {};
  if (topic !== undefined) filters.topic = topic;
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    filters[key] = value;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    filters.priority = priority as BusPriority;
  }
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.since = resolved;
  }
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.before = resolved;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) filters.contains = contains;

  return { channel, after, limit, matched, filters };
}

export interface FleetBusChannelDeps {
  read?: typeof readAgentChannel;
}

export interface FleetBusChannelResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** The requested channel name on a refused read; the resolved name on `ok`. */
  channel: string;
  status: ChannelReadPage['status'];
  reason?: string;
  messages?: ChannelReadMessage[];
  nextCursor?: number;
  matched?: number;
}

/**
 * One channel transcript page through the shared `readAgentChannel`
 * projection — the identical read `phm agents bus channel read` runs, so
 * presence-heartbeat exclusion, topic derivation, sender matching, hold
 * evidence and job annotations can never diverge between the CLI and this
 * tool. Non-ok pages pass through untouched with their own status and
 * reason: `invalid`, `unknown-channel`, `unavailable` and `retryable` each
 * stay themselves, never an invented empty transcript, and `ok` keeps
 * `nextCursor` for resuming plus `matched` only when the read asked for
 * the whole-store count. `nextCursor` is the same honest resume point
 * `phm agents bus channel read` reports — under `matched` the core page's
 * cursor is the store's end, so the adapter reports the newest shown row's
 * cursor instead, or a client resuming there would skip every unshown match.
 */
export async function readFleetBusChannel(
  args: FleetBusChannelArgs,
  deps: FleetBusChannelDeps = {},
): Promise<FleetBusChannelResult> {
  const read = deps.read ?? readAgentChannel;
  const page: ChannelReadPage = read(args.channel, {
    after: args.after, limit: args.limit, matched: args.matched, ...args.filters,
  });
  const base = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const, authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  if (page.status !== 'ok') {
    return { ...base, channel: args.channel, status: page.status, reason: page.reason };
  }
  return {
    ...base, channel: page.channel, status: 'ok' as const,
    messages: page.messages, nextCursor: busPageResumeCursor(page),
    ...(page.matched === undefined ? {} : { matched: page.matched }),
  };
}
