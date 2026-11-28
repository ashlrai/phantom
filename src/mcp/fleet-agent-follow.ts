/**
 * `fleet_agent_follow` MCP adapter: a bounded watch over one agent's
 * addressed bus inbox — `followAgentBus`, the same streaming projection
 * `phm agents bus follow` serves, where `fleet_agent_inbox` answers one
 * page and `fleet_agent_work` one digest snapshot. An MCP-connected agent
 * that needs to wait for a reply or a claimable assignment previously had
 * to busy-poll `fleet_agent_inbox`; this tool runs the same bounded
 * follower the CLI stream runs and returns the message records it emitted
 * inside one call, so "watch my inbox for the next N seconds" is one
 * bounded read, not a poll loop.
 *
 * Every filter validates before the follower runs and maps onto the same
 * page fields the CLI flags and `fleet_agent_inbox` fill, so an MCP client
 * can never disagree with the CLI about what a value means; `agent`
 * resolves through the server-owned identity registry inside the shared
 * `readAgentInbox` projection with the same handle/`agent:`/stable-id/
 * alias refs, and an unregistered ref ends the stream `unknown-agent`,
 * never a guessed match. `durationMs` is required and capped at
 * MAX_FLEET_AGENT_FOLLOW_MS — the follower's own bounded lifetime is
 * mandatory, never open-ended — and collection stops at
 * MAX_FLEET_AGENT_FOLLOW_RECORDS message records with outcome `limit`,
 * cancelling the follower; `cursor` is always the safe at-least-once
 * resume point to pass back as `after`.
 *
 * Read-only: no caller root, path or cwd is accepted — the store,
 * registry, hold table and feed roots stay server-owned — and the tool
 * never claims, acks, replies, posts or renews TTL. Routing labels are
 * data, never authenticated identity; an unreadable store, registry or
 * hold table stays `source-unavailable`/`retryable`-honest and `held`/
 * `job` stay null or unknown inside each record, never an empty inbox or
 * proven-free work passed off as fact. Records carry the same
 * `readAgentInbox` projection `fleet_agent_inbox` returns — delivery
 * kind, resolved sender, live held/holder and job feed-state evidence,
 * and the scrubbed one-line `summary` — with envelope bodies as untrusted
 * data the caller interprets.
 */
import {
  followAgentBus,
  type AgentBusFollowMessage, type AgentBusFollowRecord, type AgentBusFollowRequest,
  type AgentBusFollowResult, type AgentBusFollowStatus,
} from '../core/agents/bus-follow.js';
import {
  BUS_FOLLOW_MAX_INTERVAL_MS, BUS_FOLLOW_MIN_INTERVAL_MS,
} from '../core/fleet/bus-follow-stream.js';
import { INBOX_KINDS, busReadContains, type InboxKind } from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import type { FleetAgentInboxFilters } from './fleet-agent-inbox.js';

/** Largest `durationMs` the tool accepts — the MCP bounded-wait ceiling `fleet_reset_follow` sets too. */
export const MAX_FLEET_AGENT_FOLLOW_MS = 60_000;
/** Largest message-record count one call returns before it reports `limit`. */
export const MAX_FLEET_AGENT_FOLLOW_RECORDS = 200;

/** The printable-label rule `agent`, `thread`, `from`, `excludeFrom`, `with`, `job`, `inReplyTo`, `id` and `bodyKind` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const FOLLOW_KEYS = new Set([
  'agent', 'after', 'durationMs', 'intervalMs',
  'thread', 'from', 'excludeFrom', 'with', 'priority', 'kind', 'job', 'since', 'before', 'channel', 'topic', 'contains', 'inReplyTo', 'id', 'bodyKind', 'result',
]);
const LABEL_KEYS = ['thread', 'from', 'excludeFrom', 'with', 'job', 'inReplyTo', 'id', 'bodyKind'] as const;

export interface FleetAgentFollowArgs {
  /** Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias — resolved through the server-side registry. */
  agent: string;
  /** Resume cursor: only rows scanned after it emit. Default 0 replays retained mail. */
  after: number;
  /** Bounded watch lifetime in milliseconds — required, 1..MAX_FLEET_AGENT_FOLLOW_MS. */
  durationMs: number;
  /** Poll interval in milliseconds; the follower's own 100..60000 bound applies when omitted. */
  intervalMs?: number;
  /** The same page filters `fleet_agent_inbox` takes. */
  filters: FleetAgentInboxFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent`
 * and `durationMs` are required — the addressed watch has no meaningful
 * default agent and the follower's bounded lifetime is mandatory — and
 * every other key takes the same value rules `phm agents bus follow`
 * flags, `fleet_agent_inbox` and the other bus reads share: printable
 * routing labels, the P0–P3 priority enum, the four delivery kinds, the
 * channel-name schema, the shared `since` grammar, the bounded `contains`
 * needle normalized by `busReadContains`, and the follower's own
 * interval bounds. Unknown keys, wrong types, caller roots and malformed
 * values are all refused before the store is touched.
 */
export function parseFleetAgentFollowArgs(args: Record<string, unknown>): FleetAgentFollowArgs | null {
  if (Object.keys(args).some(key => !FOLLOW_KEYS.has(key))) return null;
  const agent = args.agent;
  if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;
  const after = args.after ?? 0;
  if (args.after === null || typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return null;
  const durationMs = args.durationMs;
  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_FLEET_AGENT_FOLLOW_MS) return null;
  const intervalMs = args.intervalMs;
  if (intervalMs !== undefined &&
      (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) ||
        intervalMs < BUS_FOLLOW_MIN_INTERVAL_MS || intervalMs > BUS_FOLLOW_MAX_INTERVAL_MS)) return null;

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
  const result = args.result;
  if (result !== undefined) {
    if (typeof result !== 'string' || !(WORK_RESULT_OUTCOMES as readonly string[]).includes(result)) return null;
    filters.result = result as WorkResultOutcome;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    filters.channel = channel;
  }
  const topic = args.topic;
  if (topic !== undefined) {
    if (typeof topic !== 'string' || !agentChannelNameSchema.safeParse(topic).success) return null;
    filters.topic = topic;
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

  return {
    agent, after, durationMs,
    ...(intervalMs === undefined ? {} : { intervalMs: intervalMs as number }),
    filters,
  };
}

export interface FleetAgentFollowDeps {
  /** The bounded follower; defaults to `followAgentBus`. Injectable for tests. */
  follow?: typeof followAgentBus;
}

/** The follower's own terminal vocabulary plus the wrapper-only `limit` record-bound outcome. */
export type FleetAgentFollowOutcome = AgentBusFollowStatus | 'limit';

export interface FleetAgentFollowResult {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  /** The requested ref the watch ran under — a handle, `agent:<handle>`, stable id or alias. */
  agent: string;
  /** Terminal outcome: the follower's own status, or `limit` when the record bound stopped collection. */
  outcome: FleetAgentFollowOutcome;
  /** Safe at-least-once resume cursor — pass back as `after` to continue without re-emitting. */
  cursor: number;
  /** Message records the follower accepted during the watch — may exceed `records.length` when `outcome` is `limit`. */
  delivered: number;
  /** Wall-clock milliseconds the watch ran. */
  elapsedMs: number;
  /** The emitted message records in emission order — the `readAgentInbox` projection plus its scrubbed summary. */
  records: AgentBusFollowMessage[];
  note: string;
}

const NOTE = 'Bounded addressed-inbox watch only: the message records followAgentBus emitted inside this call, oldest scan order, never a live delivery guarantee or a proven-free/held verdict beyond each record\'s own held/job evidence. An empty records list means no matching mail was emitted inside the call, not that the inbox is empty; pass cursor back as `after` to resume without re-emitting.';

/**
 * One bounded follow at the configured default root. The wrapper owns an
 * AbortController only to stop the follower at the record bound and to
 * forward caller cancellation — the follower's own deadline, interval and
 * cleanup bound every other exit — and collects only `type:'message'`
 * records: checkpoint records are cursor bookkeeping the `cursor` field
 * already reports, never payload. Once the record bound is reached the
 * emit stops storing and aborts the follower, which ends it `cancelled`;
 * the wrapper reports that as `limit`. `delivered` is the follower's own
 * accepted-message count, so under `limit` it can exceed `records.length`
 * — the honest "this many were emitted, this bounded slice is what fits".
 * The result keeps the follower's own terminal status — `expired`,
 * `cancelled`, `source-unavailable`, `output-unavailable`, `invalid`,
 * `unknown-agent` — never an invented empty watch.
 */
export async function readFleetAgentFollow(
  args: FleetAgentFollowArgs,
  signal?: AbortSignal,
  deps: FleetAgentFollowDeps = {},
): Promise<FleetAgentFollowResult> {
  const follow = deps.follow ?? followAgentBus;
  const records: AgentBusFollowMessage[] = [];
  const controller = new AbortController();
  let limited = false;
  const onCallerAbort = (): void => { controller.abort(); };
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const emit = (record: AgentBusFollowRecord): void => {
    if (record.type !== 'message') return;
    if (records.length < MAX_FLEET_AGENT_FOLLOW_RECORDS) records.push(record);
    if (records.length >= MAX_FLEET_AGENT_FOLLOW_RECORDS) { limited = true; controller.abort(); }
  };
  const request: AgentBusFollowRequest = {
    agent: args.agent, after: args.after, durationMs: args.durationMs,
    ...(args.intervalMs === undefined ? {} : { intervalMs: args.intervalMs }),
    ...args.filters,
  };
  let result: AgentBusFollowResult;
  try {
    result = await follow(request, {}, { emit, signal: controller.signal });
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onCallerAbort);
  }
  const outcome: FleetAgentFollowOutcome = limited ? 'limit' : result.status;
  return {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
    agent: args.agent, outcome, cursor: result.cursor,
    delivered: result.delivered, elapsedMs: result.elapsedMs,
    records, note: NOTE,
  };
}
