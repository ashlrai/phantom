/**
 * `fleet_agent_inbox` MCP adapter: the per-agent addressed bus inbox —
 * `readAgentInbox`, the same read `phm agents bus inbox` and `work mine`'s
 * inbox section serve. `fleet_bus_inbox` pages the raw durable store by
 * routing label; this tool answers the question an MCP-connected agent
 * actually asks — "what is addressed to me" — with the projection's own
 * delivery kinds (dm, channel, handoff, legacy), identity-label sender
 * matching, channel membership, live `held`/`holder` hold evidence and the
 * `job` feed-state annotation, none of which the raw page computes.
 *
 * Every filter validates before any store read and maps onto the same page
 * fields the CLI flags fill, so an MCP client can never disagree with the
 * CLI about what a value means; `agent` resolves through the server-owned
 * identity registry with the same handle/`agent:`/stable-id/alias refs
 * `resolveAgent` accepts, and an unregistered ref answers `unknown-agent`,
 * never a guessed match. Read-only: no caller root, path or cwd is accepted
 * — the store, registry, hold table and feed roots stay server-owned — and
 * the tool never claims, acks, replies, posts or renews TTL. Routing labels
 * are data, never authenticated identity; an unreadable store, registry or
 * hold table stays `unavailable`/`retryable` and `held`/`job` stay null or
 * unknown, never an empty inbox or proven-free work passed off as fact.
 */
import {
  INBOX_KINDS, busPageResumeCursor, busReadContains, readAgentInbox,
  type InboxKind, type InboxMessage, type InboxPage,
} from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_INBOX_MAX_READ } from '../core/fleet/bus-inbox.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** Largest `limit` the tool accepts — the shared inbox page bound the CLI read uses too. */
export const FLEET_AGENT_INBOX_LIMIT_MAX = BUS_INBOX_MAX_READ;
export const FLEET_AGENT_INBOX_LIMIT_DEFAULT = 50;

/** The printable-label rule `agent`, `thread`, `from`, `excludeFrom`, `job`, `inReplyTo`, `id` and `bodyKind` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const INBOX_KEYS = new Set([
  'agent', 'after', 'limit', 'matched',
  'thread', 'from', 'excludeFrom', 'priority', 'kind', 'job', 'since', 'before', 'channel', 'contains', 'inReplyTo', 'id', 'bodyKind',
]);
const LABEL_KEYS = ['thread', 'from', 'excludeFrom', 'job', 'inReplyTo', 'id', 'bodyKind'] as const;

/** The `readAgentInbox` page fields the MCP arguments fill — `after`, `limit` and `matched` ride beside them. */
export interface FleetAgentInboxFilters {
  thread?: string;
  from?: string;
  excludeFrom?: string;
  priority?: BusPriority;
  kind?: InboxKind;
  job?: string;
  since?: number;
  before?: number;
  channel?: string;
  contains?: string;
  inReplyTo?: string;
  id?: string;
  bodyKind?: string;
}

export interface FleetAgentInboxArgs {
  /** Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias — resolved through the server-side registry. */
  agent: string;
  /** Persisted cursor; rows at or below it are already handled. */
  after: number;
  /** Cap on returned rows after filtering. */
  limit: number;
  /** Also report `matched`, the true filtered total across the whole retained store. */
  matched: boolean;
  filters: FleetAgentInboxFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent` is
 * required — the addressed read has no meaningful default — and every other
 * key takes the same value rules `phm agents bus inbox` flags and the other
 * bus reads share: printable routing labels (`id` the exact-envelope match),
 * the P0–P3 priority enum, the
 * four delivery kinds, the channel-name schema, the shared `since` grammar
 * and the bounded `contains` needle normalized by `busReadContains`. Unknown
 * keys, wrong types, caller roots and malformed values are all refused
 * before the store is touched.
 */
export function parseFleetAgentInboxArgs(args: Record<string, unknown>): FleetAgentInboxArgs | null {
  if (Object.keys(args).some(key => !INBOX_KEYS.has(key))) return null;
  const agent = args.agent;
  if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;
  const after = args.after ?? 0;
  if (args.after === null || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return null;
  const limit = args.limit === undefined && !('limit' in args) ? FLEET_AGENT_INBOX_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_AGENT_INBOX_LIMIT_MAX) return null;
  const matched = args.matched === undefined ? false : args.matched;
  if (typeof matched !== 'boolean') return null;

  const filters: FleetAgentInboxFilters = {};
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
  const kind = args.kind;
  if (kind !== undefined) {
    if (typeof kind !== 'string' || !(INBOX_KINDS as readonly string[]).includes(kind)) return null;
    filters.kind = kind as InboxKind;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    filters.channel = channel;
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

  return { agent, after, limit, matched, filters };
}

export interface FleetAgentInboxDeps {
  read?: typeof readAgentInbox;
}

export interface FleetAgentInboxResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** The requested ref on a refused read; the resolved handle on `ok`. */
  agent: string;
  status: InboxPage['status'];
  reason?: string;
  messages?: InboxMessage[];
  nextCursor?: number;
  matched?: number;
}

/**
 * One addressed inbox page through the shared `readAgentInbox` projection —
 * the identical read `phm agents bus inbox` runs, so kinds, sender matching,
 * channel membership, hold evidence and job annotations can never diverge
 * between the CLI and this tool. Non-ok pages pass through untouched with
 * their own status and reason: `invalid`, `unknown-agent`, `unavailable` and
 * `retryable` each stay themselves, never an invented empty page, and `ok`
 * keeps `nextCursor` for resuming plus `matched` only when the read asked
 * for the whole-store count. `nextCursor` is the same honest resume point
 * `phm agents bus inbox` reports — under `matched` the core page's cursor is
 * the store's end, so the adapter reports the newest shown row's cursor
 * instead, or a client resuming there would skip every unshown match.
 */
export async function readFleetAgentInbox(
  args: FleetAgentInboxArgs,
  deps: FleetAgentInboxDeps = {},
): Promise<FleetAgentInboxResult> {
  const read = deps.read ?? readAgentInbox;
  const page: InboxPage = read(args.agent, {
    after: args.after, limit: args.limit, matched: args.matched, ...args.filters,
  });
  const base = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const, authority: 'none' as const,
    generatedAt: new Date().toISOString(),
  };
  if (page.status !== 'ok') {
    return { ...base, agent: args.agent, status: page.status, reason: page.reason };
  }
  return {
    ...base, agent: page.agent, status: 'ok' as const,
    messages: page.messages, nextCursor: busPageResumeCursor(page),
    ...(page.matched === undefined ? {} : { matched: page.matched }),
  };
}
