/**
 * The shared bus-hop read behind `fleet_bus_hops` and `phm fleet bus-hops`:
 * newest validated cross-agent bus hops (append order) from the private hop
 * log — the only source. A hop is a recorded send attempt: it carries message
 * id, from/to and nullable token usage, never a body, delivery, or lifecycle
 * claim. Missing and unreadable are distinct; neither yields invented rows.
 * Usage totals are subtotals of the returned tail's recorded attempts, not
 * provider usage or proof of delivery; unknown samples remain separate.
 *
 * The read scans the bounded tail window once (`BUS_HOPLOG_TAIL_MAX_ROWS`),
 * then applies the optional `from`/`to`/`excludeFrom`/`id`/`channel`/`topic`
 * filters and returns the newest `limit` matches oldest-first. `matched`
 * counts the filter hits inside that scanned window — a lower bound when
 * `truncated` reports rows beyond it, never a fleet-wide total the bounded
 * read cannot prove.
 *
 * `options.root` is the fleet store root every bus read resolves — the same
 * `join(root, 'bus', 'hops.jsonl')` hoplog path `agents bus status` probes and
 * the same root `readAgentRegistry` resolves identities under, so the CLI's
 * `--root` and the MCP server's fixed roots can never disagree about which
 * log or registry a filtered hop read consults. Omitted, both resolve their
 * own production defaults exactly as the MCP read always has.
 */
import { join } from 'node:path';
import { BUS_HOPLOG_TAIL_MAX_ROWS, readBusHoplogTail } from './bus-hoplog.js';
import { summarizeBusHops } from './bus-hop-summary.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { groupAddressTopicOf } from './bus-group.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

export const BUS_HOPS_LIMIT_MAX = 50;

/**
 * `fleet bus-hops`/`fleet_bus_hops` arguments. `from`/`to`/`excludeFrom` are
 * routing-label refs resolved through the identity registry — the same
 * `agentRefAddressMatcher` rule `fleet_bus_inbox`'s address filters apply, so
 * a ref naming one registered identity matches every label that identity
 * answers to and an unresolvable ref or unreadable registry keeps
 * exact-label matching. `id` keeps only the hop whose message id is strictly
 * equal. `channel` keeps only hops whose `to` carries the
 * `group:<channel>:` room prefix — the same raw `to`-prefix rule every bus
 * read's `channel` filter applies, decided on the routing label with no
 * registry dependence — and `topic` keeps only hops whose `to` parses to
 * that exact topic component of a well-formed `group:<room>:<topic>`
 * address through the shared `groupAddressTopicOf`, composing with
 * `channel` into one room AND one topic exactly as every other bus read's
 * `--channel`/`--topic` pair applies; both take the strict channel-name
 * grammar and a hop addressed to an agent label, a bare `group:<room>` or
 * a malformed group address never matches either. The hop log carries no
 * timestamps, so there is deliberately no `since`/`before`: position in
 * the append order is the only ordering the store proves.
 */
export interface BusHopsArgs {
  /** Newest matching hops to return, oldest first; `matched` keeps the filtered count in the scanned window. */
  limit?: number;
  /** Sender ref — handle, `agent:<handle>`, stable id or alias — matched against every label of the resolved identity. */
  from?: string;
  /** Recipient ref under the same identity-label rule as `from`. */
  to?: string;
  /** Sender ref to drop under the same identity-label rule, inverted — it composes with `from` so a sender both included and excluded matches nothing. */
  excludeFrom?: string;
  /** Keep only the hop whose message id is strictly equal to this value — never a substring. */
  id?: string;
  /** Keep only hops addressed to `group:<channel>:*` of this bus channel — the room's whole traffic under every topic; the same raw `to`-prefix rule `fleet bus-follow --channel` and every other bus read's channel filter applies. */
  channel?: string;
  /** Keep only hops addressed to a well-formed `group:<room>:<topic>` label carrying this exact topic component — the same `groupAddressTopicOf` match every bus read's topic filter applies; composes with `channel` into one room AND one topic. */
  topic?: string;
}

export interface BusHopsReadOptions {
  /** Fleet store root: the hop log resolves to `<root>/bus/hops.jsonl` and the identity registry to `<root>` — the same pair every `--root`-taking bus read honors. */
  root?: string;
}

const BUS_HOPS_KEYS = new Set(['limit', 'from', 'to', 'excludeFrom', 'id', 'channel', 'topic']);

/**
 * Routing labels use the bus wire contract: printable ASCII tokens of 1..128
 * characters — the same dummy-envelope check `fleet_bus_inbox`'s address
 * filters apply. A label that could never appear on the bus is an argument
 * error, not an empty match.
 */
function hopsAddressLabel(value: unknown): value is string {
  return typeof value === 'string' && validateBusEnvelope({
    id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null,
  }).ok;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys,
 * non-integer or out-of-range limits and malformed labels are all refused
 * before the hop log is touched.
 */
export function parseBusHopsArgs(args: Record<string, unknown>): BusHopsArgs | null {
  if (Object.keys(args).some(key => !BUS_HOPS_KEYS.has(key))) return null;
  const limit = args.limit === undefined ? 20 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > BUS_HOPS_LIMIT_MAX) return null;
  const parsed: BusHopsArgs = { limit };
  for (const key of ['from', 'to', 'excludeFrom', 'id'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!hopsAddressLabel(value)) return null;
    parsed[key] = value;
  }
  // `channel`/`topic` take the strict channel-name grammar every bus read's
  // room and topic filters validate — the same bound `fleet bus-follow`,
  // `fleet_bus_inbox` and the addressed reads share — so a malformed room
  // or topic is a refused argument, never a silently widened match.
  for (const key of ['channel', 'topic'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !agentChannelNameSchema.safeParse(value).success) return null;
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Newest validated cross-agent bus hops (append order) from the private hop
 * log — the only source. A hop is a recorded send attempt: it carries message
 * id, from/to and nullable token usage, never a body, delivery, or lifecycle
 * claim. Missing and unreadable are distinct; neither yields invented rows.
 * Usage totals are subtotals of the returned tail's recorded attempts, not
 * provider usage or proof of delivery; unknown samples remain separate.
 */
export function readBusHops(input: BusHopsArgs = {}, options: BusHopsReadOptions = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > BUS_HOPS_LIMIT_MAX) {
    throw new RangeError('Bus hop limit must be an integer between 1 and 50.');
  }
  const tail = readBusHoplogTail(BUS_HOPLOG_TAIL_MAX_ROWS,
    options.root === undefined ? undefined : join(options.root, 'bus', 'hops.jsonl'));
  const meta = {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    sourceState: tail.state, logBytes: tail.logBytes, limit,
  };
  if (tail.state !== 'ok' || tail.hops === null) {
    return {
      ...meta, hops: null, matched: null, usageSummary: null,
      returnedHops: null, skippedRows: null, truncated: null,
    };
  }
  const registryRead = input.from === undefined && input.to === undefined && input.excludeFrom === undefined
    ? undefined : readAgentRegistry(options.root === undefined ? {} : { root: options.root });
  const registry = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const from = input.from === undefined ? undefined : agentRefAddressMatcher(input.from, registry);
  const to = input.to === undefined ? undefined : agentRefAddressMatcher(input.to, registry);
  const excludeFrom = input.excludeFrom === undefined ? undefined : agentRefAddressMatcher(input.excludeFrom, registry);
  // The room and topic filters decide on the hop's own `to` routing label —
  // the same raw-prefix and groupAddressTopicOf matches every bus read's
  // channel/topic filters apply — so they need no registry and never widen
  // on unknown identity state: an agent address, a bare `group:<room>` or a
  // malformed group label simply never matches.
  const channelPrefix = input.channel === undefined ? undefined : `group:${input.channel}:`;
  const matchedHops = tail.hops.filter(hop =>
    (from === undefined || from(hop.from)) &&
    (to === undefined || to(hop.to)) &&
    (excludeFrom === undefined || !excludeFrom(hop.from)) &&
    (input.id === undefined || hop.id === input.id) &&
    (channelPrefix === undefined || hop.to.startsWith(channelPrefix)) &&
    (input.topic === undefined || groupAddressTopicOf(hop.to) === input.topic));
  const page = matchedHops.slice(-limit);
  const hops = page.map(hop => ({
    id: hop.id, from: hop.from, to: hop.to,
    inputTokens: hop.inputTokens, outputTokens: hop.outputTokens,
  }));
  return {
    ...meta, sourceState: 'ok' as const, hops, matched: matchedHops.length,
    usageSummary: summarizeBusHops(hops), returnedHops: hops.length,
    skippedRows: tail.skippedRows,
    truncated: (tail.truncated ?? false) || matchedHops.length > hops.length,
  };
}
