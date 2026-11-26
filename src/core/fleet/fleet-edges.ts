import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { isGroupPresenceBody } from './bus-group.js';
import { agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

export interface FleetEdgeEndpoint { address: string; provider: string | null }
export interface FleetEdge { from: FleetEdgeEndpoint; to: FleetEdgeEndpoint; messages: number; messagesLastHour: number; lastAt: number }
export interface FleetEdges { schema: 'fleet.edges.v1'; source: 'available' | 'missing' | 'unavailable'; edges: FleetEdge[] | null }

/**
 * Address predicates over one envelope routing label, resolved by the read —
 * the same `agentRefAddressMatcher` contract every bus read's sender filter
 * applies. `projectFleetEdges` stays pure: it never reads the registry, so a
 * caller that wants identity-label matching resolves the predicates first.
 */
export interface FleetEdgeAddressFilter {
  /** Keep only receipts whose `from` label the predicate accepts. */
  from?: (value: string) => boolean;
  /** Keep only receipts whose `to` label the predicate accepts. */
  to?: (value: string) => boolean;
}

export interface FleetEdgesOptions extends BusInboxOptions {
  /** Trailing window in minutes; same 1..1440 bound `projectFleetEdges` enforces. */
  windowMinutes?: number;
  /**
   * Agent ref (`--from`) whose identity labels narrow the sender side: the
   * literal ref plus every label of the identity it resolves to through the
   * registry beside the bus store. An unresolvable ref or unreadable registry
   * keeps exact-label matching, so unknown identity state never widens the
   * filter — the same rule `agents bus inbox --from` applies.
   */
  from?: string;
  /**
   * Agent ref (`--to`) whose identity labels narrow the recipient side under
   * the same identity-label rule `from` applies, so "who reaches me" and
   * "who do I reach" are one filtered read each.
   */
  to?: string;
}

/** The transport dead-letter sink (docs/AGENT-BUS.md "Dead letters"): the
 * router files delivery-failure notices under this address; they are reports
 * with their own transport read, never mail between agents. Kept a literal:
 * the shared constant lives in bus-transport-file, whose import would pull
 * the transport router into this read projection's closure. */
const BUS_DEAD_LETTER_ADDRESS = 'bus.dead-letter';

/** One agent wrote to another: not a note to self, a broadcast to `leaders`, a
 * person, an outside channel, a dead-letter notice or a presence observation
 * (system traffic with its own read, never a message slot). */
export const agentToAgent = (envelope: BusInboxReceipt['envelope']): boolean =>
  !(envelope.from === envelope.to || envelope.to === 'leaders' || envelope.to === BUS_DEAD_LETTER_ADDRESS ||
    envelope.sender?.human || envelope.external || isGroupPresenceBody(envelope.body));

/** Routing labels are claims, not authenticated identities. Never expose message bodies. */
export function projectFleetEdges(rows: BusInboxReceipt[], now = Date.now(), windowMinutes?: number,
  addressFilter?: FleetEdgeAddressFilter): FleetEdge[] {
  if (windowMinutes !== undefined) {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) throw new Error('Minutes must be 1..1440');
    rows = rows.filter(row => row.receivedAt > now - windowMinutes * 60_000 && row.receivedAt <= now);
  }
  // The address filter narrows the receipt set before provider inference and
  // aggregation, the same row-level bound the window applies: the projection
  // then answers "links inside the matching traffic" self-consistently.
  if (addressFilter !== undefined) {
    rows = rows.filter(({ envelope }) =>
      (addressFilter.from === undefined || addressFilter.from(envelope.from)) &&
      (addressFilter.to === undefined || addressFilter.to(envelope.to)));
  }
  const edges = new Map<string, FleetEdge>();
  const providers = new Map<string, Set<string>>();
  for (const { envelope } of rows) {
    if (!envelope.sender?.vendor || envelope.sender.agent_id !== envelope.from || envelope.sender.human || envelope.external) continue;
    const names = providers.get(envelope.from) ?? new Set<string>();
    names.add(envelope.sender.vendor); providers.set(envelope.from, names);
  }
  const providerFor = (address: string) => { const names = providers.get(address); return names?.size === 1 ? [...names][0]! : null; };
  for (const { envelope, receivedAt } of rows) {
    if (!agentToAgent(envelope)) continue;
    const provider = providerFor(envelope.from);
    const key = JSON.stringify([envelope.from, envelope.to, provider]);
    const edge = edges.get(key);
    const recent = receivedAt > now - 3_600_000 && receivedAt <= now;
    if (edge) { edge.messages++; if (recent) edge.messagesLastHour++; edge.lastAt = Math.max(edge.lastAt, receivedAt); }
    else edges.set(key, { from: { address: envelope.from, provider }, to: { address: envelope.to, provider: providerFor(envelope.to) }, messages: 1, messagesLastHour: recent ? 1 : 0, lastAt: receivedAt });
  }
  return [...edges.values()].sort((a, b) => b.lastAt - a.lastAt || a.from.address.localeCompare(b.from.address));
}

/**
 * Resolve the `from`/`to` refs to address predicates with one registry read —
 * the same `agentRefAddressMatcher` rule every bus read's sender filter
 * applies, so a ref naming one identity also matches the handle, `agent:`
 * address, stable id and aliases its other labels prove. An unreadable
 * registry or a ref resolving to no identity keeps exact-label matching:
 * unknown identity state never widens the filter. Undefined when neither ref
 * is set, so an unfiltered read never touches the registry.
 */
function fleetEdgeAddressFilter(options: FleetEdgesOptions): FleetEdgeAddressFilter | undefined {
  if (options.from === undefined && options.to === undefined) return undefined;
  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  return {
    ...(options.from === undefined ? {} : { from: agentRefAddressMatcher(options.from, registry) }),
    ...(options.to === undefined ? {} : { to: agentRefAddressMatcher(options.to, registry) }),
  };
}

export function readFleetEdges(options: FleetEdgesOptions = {}): FleetEdges {
  const source = inspectBusInbox(options).source;
  if (source !== 'available') return { schema: 'fleet.edges.v1', source, edges: null };
  const addressFilter = fleetEdgeAddressFilter(options);
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let page = 0; page <= BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ; page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options);
    if (result.status !== 'ok') return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
    rows.push(...result.messages);
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) return { schema: 'fleet.edges.v1', source, edges: projectFleetEdges(rows, options.now?.() ?? Date.now(), options.windowMinutes, addressFilter) };
    cursor = result.nextCursor;
  }
  return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
}
