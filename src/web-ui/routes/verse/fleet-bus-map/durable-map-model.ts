import type { BusHop } from '../fleet/bus-feed-queries.js';
import type { AgentBusMapPage } from './agent-bus-map-queries.js';
import { buildBusMap, lastHopText, type BusMap } from './bus-map-model.js';

type DurableHop = BusHop & { at: number; kind: string };
export type DurableMap = BusMap & { lastReceivedAt: number | null };

export function durableHops(page: AgentBusMapPage): DurableHop[] {
  return page.messages.map(({ receivedAt, envelope }) => ({
    id: envelope.id, from: envelope.from, to: envelope.to, at: receivedAt,
    kind: envelope.body !== null && typeof envelope.body === 'object' && !Array.isArray(envelope.body)
      && typeof envelope.body.kind === 'string' ? envelope.body.kind : envelope.priority,
    inputTokens: null, outputTokens: null,
  }));
}

export function buildDurableMap(page: AgentBusMapPage): DurableMap {
  const hops = durableHops(page);
  return { ...buildBusMap(hops), lastReceivedAt: hops.length ? Math.max(...hops.map(hop => hop.at)) : null };
}

export function durableTotalsLine(map: DurableMap, nowMs: number): string | null {
  if (map.lastReceivedAt === null) return null;
  const freshness = lastHopText(new Date(map.lastReceivedAt).toISOString(), nowMs).replace('last hop', 'last');
  const pair = map.pairs[0];
  return `Durable bus: ${map.totals.hops.toLocaleString()} envelopes, ${map.agents.length.toLocaleString()} agents, ${freshness} (${pair.from} → ${pair.to} ${pair.hops.toLocaleString()}).`;
}
