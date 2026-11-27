/**
 * `fleet_bus_thread` MCP adapter: the reply-thread context read —
 * `readBusThread`, the same `fleet.bus-thread.v1` projection
 * `ashlr fleet bus-thread --id <id>` serves. Every other bus read answers
 * one slice — `fleet_bus_show` one envelope, `fleet_bus_inbox` one raw
 * page, `fleet_agent_conversations` the classified thread groups,
 * `fleet_agent_messages` the flat timeline — and none reconstructs the
 * retained reply chain around one id: the root receipt plus every live
 * envelope whose own `inReplyTo` field transitively cites it, scanned in
 * cursor order across the whole bounded store. That chain is the context a
 * worker or coordinator needs before acting on a request — including the
 * kindless `{inReplyTo, text}` replies `comms bus reply` and
 * `fleet bus-reply` post, which the classified projections never group —
 * and today only the CLI read reaches it, so an MCP-connected agent would
 * have to shell out to `phm` for what every sibling read already serves.
 *
 * `id` is required and takes the same printable routing-label rule the
 * `fleet bus-thread --id` flag and `fleet_bus_show`'s `id` apply — the
 * envelope wire id the thread roots at — validated before any store read;
 * unknown keys, caller roots, paths and working directories are refused
 * the same way. The optional filters are the shared bus-read set every
 * sibling tool already takes — `to`/`from`/`excludeFrom` resolved through
 * the server-side registry with exact-label fallback, `channel`, `job`,
 * `priority`, `thread`, `inReplyTo`, `bodyKind`, `result`, the
 * `[since, before)` receivedAt window and `contains` — and they narrow the
 * listed chain members only: the `inReplyTo` walk, `rootFound` and the
 * `scannedThrough`/`complete`/`sourceFailure` honesty fields still
 * describe the whole chain, so a root whose every member a filter
 * excludes reports `rootFound: true` with an empty `messages`, never a
 * proven miss. The read runs with live evidence: every message carries
 * the same `held`/`holder`/`job`/`fromAgent` annotations `fleet_agent_inbox`,
 * `fleet_bus_channel` and `fleet_bus_show` report, through the shared
 * `annotateLiveEvidence` rule, so the chain answers whether its claimable
 * work is taken and where its cited jobs stand without a lookup per
 * message. Read-only: the store root stays server-owned, the bounded
 * page walk writes nothing and never posts, claims, acks, replies or
 * renews TTL. Routing labels are data, never authenticated identity;
 * envelope bodies are untrusted data the caller interprets, and a thread
 * whose root is expired, reclaimed or never posted reports
 * `rootFound: false` — a proven miss — while `complete: false` with a
 * `sourceFailure` names an unreadable or invalid page walk, never an
 * invented empty thread passed off as fact.
 */
import { parseSince } from '../core/fleet/agent-messages.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { readBusThread, type BusThreadFilters, type BusThreadResult } from '../core/fleet/bus-thread-context.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { busReadContains } from '../core/agents/bus-unified.js';
import { WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';

/** The printable routing-label rule `fleet bus-thread --id` applies to the root envelope id. */
const BUS_ID = /^[\x21-\x7e]{1,128}$/;
/** The printable-label rule the shared filter refs take — the same grammar fleet_agent_messages applies. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const THREAD_KEYS = new Set(['id', 'to', 'from', 'excludeFrom', 'channel', 'job', 'priority',
  'thread', 'inReplyTo', 'bodyKind', 'result', 'since', 'before', 'contains']);
const LABEL_KEYS = ['to', 'from', 'excludeFrom', 'job', 'thread', 'inReplyTo', 'bodyKind'] as const;

export interface FleetBusThreadArgs {
  /** Envelope wire id the reply thread roots at. */
  id: string;
  /** The shared bus-read filters narrowing the projected chain members — absent keys mean no filter. */
  filters?: BusThreadFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `id` is
 * required — the thread read has no meaningful default — and takes the
 * same printable routing-label rule every bus read shares; every filter
 * takes the same value rule the sibling bus tools enforce — the label
 * keys the printable-label grammar, `channel` the strict channel-name
 * schema, `priority`/`result` their enums, `since`/`before` the shared
 * 15m/2h/1d/epoch-ms/ISO grammar resolved through `parseSince` to a safe
 * non-negative epoch-ms integer and `contains` the bounded
 * `busReadContains` needle. Unknown keys, wrong types, caller roots and
 * malformed values are all refused before the store is touched.
 */
export function parseFleetBusThreadArgs(args: Record<string, unknown>): FleetBusThreadArgs | null {
  if (Object.keys(args).some(key => !THREAD_KEYS.has(key))) return null;
  const id = args.id;
  if (typeof id !== 'string' || !BUS_ID.test(id)) return null;
  const filters: BusThreadFilters = {};
  let any = false;
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    filters[key] = value;
    any = true;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    filters.channel = channel;
    any = true;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    filters.priority = priority as BusPriority;
    any = true;
  }
  const outcome = args.result;
  if (outcome !== undefined) {
    if (typeof outcome !== 'string' || !(WORK_RESULT_OUTCOMES as readonly string[]).includes(outcome)) return null;
    filters.result = outcome as WorkResultOutcome;
    any = true;
  }
  for (const key of ['since', 'before'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    const resolved = parseSince(value);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters[key] = resolved;
    any = true;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) { filters.contains = contains; any = true; }
  return any ? { id, filters } : { id };
}

export interface FleetBusThreadDeps {
  read?: typeof readBusThread;
}

interface FleetBusThreadMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared thread result with the MCP envelope metadata on it. */
export type FleetBusThreadResult = FleetBusThreadMeta & BusThreadResult;

/**
 * One reply-thread read through the shared `readBusThread` projection —
 * the identical bounded page walk `ashlr fleet bus-thread --id` runs, so
 * the live-only TTL recheck, the `inReplyTo` descendant selection, the
 * `scannedThrough` cursor and the `complete`/`sourceFailure` honesty can
 * never diverge between the CLI and this tool. The read runs with
 * `liveEvidence`, so each message also carries the `held`/`holder`/`job`/
 * `fromAgent` annotations the unified bus reads report, and any parsed
 * filters apply the same member-narrowing rule the CLI flags do. The
 * result passes through untouched: `rootFound` stays the projection's own
 * verdict — a live root whose every member a filter excludes still
 * reports `rootFound: true` with an empty `messages`, never a proven
 * miss — `messages` keeps every selected live receipt that satisfies the
 * filters in cursor order and a failed or incomplete walk keeps its own
 * `complete: false` and `sourceFailure` reason — never an invented thread
 * or a proven-empty list passed off as a miss.
 */
export async function readFleetBusThread(
  args: FleetBusThreadArgs,
  deps: FleetBusThreadDeps = {},
): Promise<FleetBusThreadResult> {
  const read = deps.read ?? readBusThread;
  const thread = read(args.id, { liveEvidence: true, filters: args.filters });
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...thread,
  };
}
