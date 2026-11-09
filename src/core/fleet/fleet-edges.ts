import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';

export interface FleetEdgeEndpoint { address: string; provider: string | null }
export interface FleetEdge { from: FleetEdgeEndpoint; to: FleetEdgeEndpoint; messages: number; lastAt: number }
export interface FleetEdges { schema: 'fleet.edges.v1'; source: 'available' | 'missing' | 'unavailable'; edges: FleetEdge[] | null }

/** Routing labels are claims, not authenticated identities. Never expose message bodies. */
export function projectFleetEdges(rows: BusInboxReceipt[]): FleetEdge[] {
  const edges = new Map<string, FleetEdge>();
  const providers = new Map<string, Set<string>>();
  for (const { envelope } of rows) {
    if (!envelope.sender?.vendor || envelope.sender.agent_id !== envelope.from || envelope.sender.human || envelope.external) continue;
    const names = providers.get(envelope.from) ?? new Set<string>();
    names.add(envelope.sender.vendor); providers.set(envelope.from, names);
  }
  const providerFor = (address: string) => { const names = providers.get(address); return names?.size === 1 ? [...names][0]! : null; };
  for (const { envelope, receivedAt } of rows) {
    if (envelope.from === envelope.to || envelope.to === 'leaders' || envelope.sender?.human || envelope.external) continue;
    const provider = providerFor(envelope.from);
    const key = JSON.stringify([envelope.from, envelope.to, provider]);
    const edge = edges.get(key);
    if (edge) { edge.messages++; edge.lastAt = Math.max(edge.lastAt, receivedAt); }
    else edges.set(key, { from: { address: envelope.from, provider }, to: { address: envelope.to, provider: providerFor(envelope.to) }, messages: 1, lastAt: receivedAt });
  }
  return [...edges.values()].sort((a, b) => b.lastAt - a.lastAt || a.from.address.localeCompare(b.from.address));
}

export function readFleetEdges(options: BusInboxOptions = {}): FleetEdges {
  const source = inspectBusInbox(options).source;
  if (source !== 'available') return { schema: 'fleet.edges.v1', source, edges: null };
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let page = 0; page <= BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ; page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options);
    if (result.status !== 'ok') return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
    rows.push(...result.messages);
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) return { schema: 'fleet.edges.v1', source, edges: projectFleetEdges(rows) };
    cursor = result.nextCursor;
  }
  return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
}
