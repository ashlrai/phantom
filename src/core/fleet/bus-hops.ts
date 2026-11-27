/**
 * Local, observation-only read of the bus hop log's newest validated hops —
 * the single projection `fleet_bus_hops` serves over MCP and
 * `phm fleet bus-hops` prints on the CLI. A hop is a recorded send attempt:
 * it carries message id, from/to and nullable token usage, never a body,
 * delivery, or lifecycle claim. Missing and unreadable are distinct; neither
 * yields invented rows. Usage totals are subtotals of the returned tail's
 * recorded attempts, not provider usage or proof of delivery; unknown samples
 * remain separate.
 *
 * The read scans the bounded tail window once (`BUS_HOPLOG_TAIL_MAX_ROWS`),
 * then applies the optional `from`/`to`/`excludeFrom`/`id`/`channel`/`topic`
 * filters and returns the newest `limit` matches oldest-first. `matched`
 * counts the filter hits inside that scanned window — a lower bound when
 * `truncated` reports rows beyond it, never a fleet-wide total the bounded
 * read cannot prove. The hop log carries no timestamps, so there is
 * deliberately no `since`/`before`: position in the append order is the only
 * ordering the store proves.
 *
 * Argument validation stays with each front end: the MCP adapter refuses
 * malformed labels before calling, and the CLI applies the same routing-label
 * and channel-name grammar on argv. This read matches whatever filters it is
 * given — an unresolvable ref or unreadable registry keeps exact-label
 * matching, so unknown identity state never widens the read.
 */
import { BUS_HOPLOG_TAIL_MAX_ROWS, readBusHoplogTail } from './bus-hoplog.js';
import { summarizeBusHops } from './bus-hop-summary.js';
import { groupAddressTopicOf } from './bus-group.js';
import { agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

/** The newest-hops bound every bus-hops surface shares (1 through 50, default 20). */
export const BUS_HOPS_MAX_LIMIT = 50;

export interface BusHopsReadInput {
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
  /** Keep only hops addressed to `group:<channel>:*` of this bus channel — the room's whole traffic under every topic; the same raw `to`-prefix rule every other bus read's channel filter applies. */
  channel?: string;
  /** Keep only hops addressed to a well-formed `group:<room>:<topic>` label carrying this exact topic component — the same `groupAddressTopicOf` match every bus read's topic filter applies; composes with `channel` into one room AND one topic. */
  topic?: string;
}

export function readBusHops(input: BusHopsReadInput = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > BUS_HOPS_MAX_LIMIT) {
    throw new RangeError('Bus hop limit must be an integer between 1 and 50.');
  }
  const tail = readBusHoplogTail(BUS_HOPLOG_TAIL_MAX_ROWS);
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
    ? undefined : readAgentRegistry();
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
