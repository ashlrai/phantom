/**
 * `fleet_agent_edges` MCP adapter: the agent-to-agent message-link
 * projection — `readFleetEdges`, the same `fleet.edges.v1` read
 * `phm fleet edges`, `ashlr agents edges` and the Fleet world map serve.
 * `fleet_agent_messages` lists every classified agent-to-agent message
 * newest-first, `fleet_agent_conversations` groups them into threads and
 * `fleet_bus_inbox` pages the raw store; none answers the topology
 * question "which agents message which, how often and how recently"
 * fleet-wide in one read.
 *
 * Every argument is optional and takes the same value rules the
 * `phm fleet edges` flags share, all validated before any store read:
 * `windowMinutes` an integer in 1–1440 — the same bound
 * `--window-minutes` and the org map's `minutes` parameter apply —
 * `from`/`to` printable routing labels resolved through the
 * server-owned registry under the same `agentRefAddressMatcher` rule
 * every bus read's sender filter applies: the literal ref plus every
 * label of the identity it resolves to, exact-label matching kept on an
 * unresolvable ref or unreadable registry so unknown identity state
 * never widens the filter — and `channel`/`topic` the strict
 * channel-name grammar every other bus read's room filters enforce:
 * `channel` keeps only links whose receipts are addressed to
 * `group:<channel>:*` — the room's whole traffic under every topic —
 * while `topic` keeps only links whose `to` parses to that exact topic
 * through the shared `groupAddressTopicOf`, composing with `channel`
 * into one room AND one topic exactly as `phm fleet edges --channel
 * --topic` applies — and the shared row-slice vocabulary every other
 * bus read applies before its projection: `since`/`before` the
 * `15m|2h|1d|ISO|epoch` grammar resolved to the `[since, before)`
 * window on receipt time, `priority` one exact P0–P3 band, `kind` one
 * classified agent-message kind (ask/reply/handoff/status/blocker,
 * matched case-insensitively), `job` the printable job label the
 * shared `busBodyJobMatch` rule resolves and `contains` the bounded
 * case-insensitive summary needle. The filters compose with each
 * other and with the window — every one narrows the receipt set
 * before it aggregates, so counts, `lastAt` and provider inference
 * describe only the matching traffic. Unknown keys, wrong types,
 * caller roots, paths and working directories are all refused before
 * the store is touched.
 *
 * The result is the projection untouched plus the MCP envelope
 * metadata: `source` keeps missing/unavailable honest — an unreadable
 * store is never an invented empty edge list and `edges` stays null —
 * provider labels come only from sender metadata observed on the
 * filtered receipts (a provider proven only by excluded traffic, a
 * missing or conflicting one stays null — unknown, never guessed), and
 * routing labels are claims, never authenticated identities; no message
 * bodies are exposed. Read-only: no caller root, path or cwd is
 * accepted — the bus store and registry roots stay server-owned — and
 * the tool never posts, claims, acks, replies or renews TTL.
 */
import { readFleetEdges, type FleetEdges, type FleetEdgesOptions } from '../core/fleet/fleet-edges.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { AGENT_MESSAGE_KINDS, parseSince, type AgentMessageKind } from '../core/fleet/agent-messages.js';
import { busReadContains } from '../core/agents/bus-unified.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';

/** The printable routing-label rule every bus read's `--from`/`--to` filter validates. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const EDGE_KEYS = new Set(['windowMinutes', 'from', 'to', 'channel', 'topic',
  'since', 'before', 'priority', 'kind', 'job', 'contains']);

/**
 * The parsed arguments are the projection's own option subset — the MCP
 * surface adds no filter the CLI flags do not share and accepts no
 * caller root, path, working directory or clock. `since`/`before` arrive as
 * the shared `15m|2h|1d|ISO|epoch` grammar strings and resolve to epoch-ms
 * bounds here, the same convention `fleet_agent_messages` applies.
 */
export type FleetAgentEdgesArgs = FleetEdgesOptions;

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every
 * key is optional — the link read has no required ref — and each takes
 * the same value rule `phm fleet edges` enforces on its flags:
 * `windowMinutes` stays an integer inside 1..1440 (the bound
 * `projectFleetEdges` would throw on is refused here instead), `from`
 * and `to` stay printable routing labels, `channel`/`topic` take
 * the strict channel-name grammar every other bus read's room filters
 * enforce, and the row-slice fields take the shared bus-read rules —
 * `since`/`before` resolve through `parseSince` to a safe non-negative
 * epoch-ms integer (`before` the exclusive upper bound composing with
 * `since` into one `[since, before)` window), `priority` stays an exact
 * P0..P3 member, `kind` lowercases into the classified-kind enum,
 * `job` takes the printable job label and `contains` the bounded needle
 * `busReadContains` normalizes. Unknown keys, wrong types, caller roots
 * and malformed values are all refused before the store is touched.
 */
export function parseFleetAgentEdgesArgs(args: Record<string, unknown>): FleetAgentEdgesArgs | null {
  if (Object.keys(args).some(key => !EDGE_KEYS.has(key))) return null;
  const options: FleetEdgesOptions = {};
  const windowMinutes = args.windowMinutes;
  if (windowMinutes !== undefined) {
    if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
      return null;
    }
    options.windowMinutes = windowMinutes;
  }
  const from = args.from, to = args.to;
  if ((from !== undefined && (typeof from !== 'string' || !BUS_LABEL.test(from))) ||
    (to !== undefined && (typeof to !== 'string' || !BUS_LABEL.test(to)))) return null;
  if (from !== undefined) options.from = from as string;
  if (to !== undefined) options.to = to as string;
  const channel = args.channel, topic = args.topic;
  if ((channel !== undefined && (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success)) ||
    (topic !== undefined && (typeof topic !== 'string' || !agentChannelNameSchema.safeParse(topic).success))) return null;
  if (channel !== undefined) options.channel = channel as string;
  if (topic !== undefined) options.topic = topic as string;
  for (const key of ['since', 'before'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    const resolved = parseSince(value);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    options[key] = resolved;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    options.priority = priority as BusPriority;
  }
  const kind = args.kind;
  if (kind !== undefined) {
    if (typeof kind !== 'string') return null;
    const normalized = kind.toLowerCase();
    if (!(AGENT_MESSAGE_KINDS as readonly string[]).includes(normalized)) return null;
    options.kind = normalized as AgentMessageKind;
  }
  const job = args.job;
  if (job !== undefined) {
    if (typeof job !== 'string' || !BUS_LABEL.test(job)) return null;
    options.job = job;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) options.contains = contains;
  return options;
}

export interface FleetAgentEdgesDeps {
  read?: typeof readFleetEdges;
}

export type FleetAgentEdgesResult = FleetEdges & {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
};

/**
 * One link projection through the shared `readFleetEdges` read — the
 * identical projection `phm fleet edges` and `ashlr agents edges` run,
 * so the agent-to-agent filter, window bound, identity-label matching,
 * provider inference and missing/unavailable honesty can never diverge
 * between the CLI and this tool. The projection's `schema`, `source`
 * and `edges` pass through untouched — a missing or unreadable store
 * stays `missing`/`unavailable` with `edges` null, never an invented
 * empty list — under the standard MCP envelope metadata.
 */
export async function readFleetAgentEdges(
  args: FleetAgentEdgesArgs,
  deps: FleetAgentEdgesDeps = {},
): Promise<FleetAgentEdgesResult> {
  const read = deps.read ?? readFleetEdges;
  const result: FleetEdges = read(args);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
