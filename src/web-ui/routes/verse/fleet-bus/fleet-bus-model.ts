import type { BusEvent, BusHop, BusKind } from '../fleet/bus-feed-queries.js';

function sumTokens(hops: readonly BusHop[], field: 'inputTokens' | 'outputTokens'): number | null {
  let total: number | null = null;
  for (const hop of hops) {
    const value = hop[field];
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - (total ?? 0)) return null;
    total = (total ?? 0) + value;
  }
  return total;
}

export function summarizeHops(hops: readonly BusHop[]) {
  const agents = new Set<string>();
  for (const hop of hops) { agents.add(hop.from); agents.add(hop.to); }
  return { hops: hops.length, inputTokens: sumTokens(hops, 'inputTokens'),
    outputTokens: sumTokens(hops, 'outputTokens'), agents: agents.size };
}

export function groupEvents(events: readonly BusEvent[], kind: BusKind | null): BusEvent[] {
  return events.filter(event => kind === null || event.kind === kind).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function isInterjection(event: BusEvent): boolean { return event.kind === 'inbox'; }
