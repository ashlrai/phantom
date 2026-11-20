import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { isGroupPresenceBody } from './bus-group.js';

export interface FleetEdgeEndpoint { address: string; provider: string | null }
export interface FleetEdge { from: FleetEdgeEndpoint; to: FleetEdgeEndpoint; messages: number; messagesLastHour: number; lastAt: number }
export interface FleetEdges { schema: 'fleet.edges.v1'; source: 'available' | 'missing' | 'unavailable'; edges: FleetEdge[] | null }

/** One agent wrote to another: not a note to self, a broadcast to `leaders`, a person, an outside channel or a presence observation (those have their own read, never a message slot). */
export const agentToAgent = (envelope: BusInboxReceipt['envelope']): boolean =>
  !(envelope.from === envelope.to || envelope.to === 'leaders' || envelope.sender?.human || envelope.external ||
    isGroupPresenceBody(envelope.body));

/** Routing labels are claims, not authenticated identities. Never expose message bodies. */
export function projectFleetEdges(rows: BusInboxReceipt[], now = Date.now(), windowMinutes?: number): FleetEdge[] {
  if (windowMinutes !== undefined) {
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) throw new Error('Minutes must be 1..1440');
    rows = rows.filter(row => row.receivedAt > now - windowMinutes * 60_000 && row.receivedAt <= now);
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

export function readFleetEdges(options: BusInboxOptions & { windowMinutes?: number } = {}): FleetEdges {
  const source = inspectBusInbox(options).source;
  if (source !== 'available') return { schema: 'fleet.edges.v1', source, edges: null };
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let page = 0; page <= BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ; page++) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options);
    if (result.status !== 'ok') return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
    rows.push(...result.messages);
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) return { schema: 'fleet.edges.v1', source, edges: projectFleetEdges(rows, options.now?.() ?? Date.now(), options.windowMinutes) };
    cursor = result.nextCursor;
  }
  return { schema: 'fleet.edges.v1', source: 'unavailable', edges: null };
}
