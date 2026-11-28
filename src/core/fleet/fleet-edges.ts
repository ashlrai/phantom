import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { groupAddressTopicOf, isGroupPresenceBody } from './bus-group.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry } from '../agents/bus-identity.js';

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

/**
 * The group-room narrowing every bus read's `--channel`/`--topic` pair
 * applies, over the raw `to` routing label — no identity resolution, so the
 * projection takes the literals directly. `channel` keeps only envelopes
 * addressed to `group:<channel>:*` — the room's whole traffic under every
 * topic — the same raw `to`-prefix rule `phm messages --channel`,
 * `agents bus inbox --channel` and `channel read --channel` match;
 * `topic` keeps only envelopes whose `to` parses to that exact topic
 * component through the shared `groupAddressTopicOf` — the same match
 * `work feed --topic`, `work next --topic`, `inbox --topic`,
 * `channel read --topic` and `comms bus next --topic` apply — composing
 * with `channel` into one room AND one topic while an agent address, a
 * bare `group:<room>` or a malformed topic never matches. A `group.presence`
 * heartbeat still drops out under `agentToAgent` either way: the room
 * filter narrows which receipts count, never what counts as mail.
 */
export interface FleetEdgeRoomFilter {
  /** Room name whose `group:<channel>:*` traffic is kept; every topic. */
  channel?: string;
  /** Exact topic component a well-formed `group:<room>:<topic>` `to` must carry. */
  topic?: string;
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
  /**
   * Bus channel name (`--channel`) keeping only receipts addressed to
   * `group:<channel>:*` — the same strict channel-name grammar and raw
   * `to`-prefix rule every other bus read's `--channel` applies.
   */
  channel?: string;
  /**
   * Group topic (`--topic`) keeping only receipts whose `to` parses to that
   * topic through `groupAddressTopicOf` — the same strict name grammar and
   * match every other bus read's `--topic` applies; composes with `channel`.
   */
  topic?: string;
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
  addressFilter?: FleetEdgeAddressFilter, roomFilter?: FleetEdgeRoomFilter): FleetEdge[] {
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
  // The room filter is the same row-level bound on the raw `to` label: a
  // channel keeps the room's traffic under every topic, a topic keeps one
  // room's one topic, and the two compose into one room AND one topic.
  if (roomFilter !== undefined) {
    const channelPrefix = roomFilter.channel === undefined ? undefined : `group:${roomFilter.channel}:`;
    rows = rows.filter(({ envelope }) =>
      (channelPrefix === undefined || envelope.to.startsWith(channelPrefix)) &&
      (roomFilter.topic === undefined || groupAddressTopicOf(envelope.to) === roomFilter.topic));
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

/** The query keys the edges link read accepts — the same five filters the
 * `phm fleet edges` flags and the `fleet_agent_edges` MCP arguments carry. */
export const FLEET_EDGES_QUERY_PARAMS = ['windowMinutes', 'from', 'to', 'channel', 'topic'] as const;

/** String-valued query input — one entry per `FLEET_EDGES_QUERY_PARAMS` key. */
export interface FleetEdgesQueryInput {
  windowMinutes?: string;
  from?: string;
  to?: string;
  channel?: string;
  topic?: string;
}

export type FleetEdgesQuery =
  | { ok: true; options: FleetEdgesOptions }
  | { ok: false; error: string };

/** Printable ASCII routing labels, the same bound the edges CLIs' --from/--to enforce. */
const EDGE_QUERY_LABEL = /^[\x21-\x7e]{1,128}(?![\s\S])/;

/**
 * Validate one edges query into the `FleetEdgesOptions` the read applies —
 * the same value rules `phm fleet edges` enforces on its flags and
 * `fleet_agent_edges` re-validates on every call: `windowMinutes` is a whole
 * number of minutes inside the projection's own 1..1440 bound, `from` and
 * `to` stay printable routing labels, and `channel`/`topic` take the strict
 * channel-name grammar every other bus read's room filters enforce. A
 * malformed value is a usage error, never a silently empty edge list.
 */
export function parseFleetEdgesQuery(input: FleetEdgesQueryInput): FleetEdgesQuery {
  const options: FleetEdgesOptions = {};
  if (input.windowMinutes !== undefined) {
    if (!/^[0-9]+$/.test(input.windowMinutes)) {
      return { ok: false, error: 'windowMinutes takes an integer from 1 to 1440.' };
    }
    const minutes = Number(input.windowMinutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
      return { ok: false, error: 'windowMinutes takes an integer from 1 to 1440.' };
    }
    options.windowMinutes = minutes;
  }
  for (const key of ['from', 'to'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!EDGE_QUERY_LABEL.test(value)) {
      return { ok: false, error: `${key} takes a printable routing label of 1-128 characters.` };
    }
    options[key] = value;
  }
  for (const key of ['channel', 'topic'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!agentChannelNameSchema.safeParse(value).success) {
      return { ok: false, error: `${key} takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).` };
    }
    options[key] = value;
  }
  return { ok: true, options };
}

export function readFleetEdges(options: FleetEdgesOptions = {}): FleetEdges {
  const source = inspectBusInbox(options).source;
  if (source !== 'available') return { schema: 'fleet.edges.v1', source, edges: null };
  const addressFilter = fleetEdgeAddressFilter(options);
  const roomFilter: FleetEdgeRoomFilter | undefined =
    options.channel === undefined && options.topic === undefined ? undefined
      : { ...(options.channel === undefined ? {} : { channel: options.channel }),
          ...(options.topic === undefined ? {} : { topic: options.topic }) };
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let page = 0; page <= BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ; page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options);
    if (result.status !== 'ok') return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
    rows.push(...result.messages);
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) return { schema: 'fleet.edges.v1', source, edges: projectFleetEdges(rows, options.now?.() ?? Date.now(), options.windowMinutes, addressFilter, roomFilter) };
    cursor = result.nextCursor;
  }
  return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
}
