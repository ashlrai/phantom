import type { BusEvent, BusHop, BusKind } from '../fleet/bus-feed-queries.js';
import { busTimeline, describeHop } from '../fleet/bus-feed-model.js';

export type BusRow = { at: string; kind: BusEvent['kind'] | 'hop'; text: string; hopId?: string };

export function busRows(events: readonly BusEvent[], hops: readonly (BusHop & { at?: string })[], limit = 60, lastHopAt: string | null = null): BusRow[] {
  // The shared timeline caps each feed at 40, so adapt one hop at a time to
  // preserve this pane's own limit. The feed supplies only a group timestamp.
  const hopRows: BusRow[] = hops.map(hop => {
    const [row] = busTimeline({ v: 1, events: [], hops: [hop], hopsDropped: 0,
      lastHopAt: hop.at ?? lastHopAt, sources: { hops: 'healthy', events: 'healthy' } });
    return { at: row.at ?? '', kind: 'hop', text: describeHop(hop), hopId: hop.id };
  });
  return groupEvents([...events, ...hopRows], null).slice(0, limit);
}

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

export function groupEvents<T extends BusRow>(events: readonly T[], kind: BusKind | 'hop' | null): T[] {
  const time = (at: string) => Number.isFinite(Date.parse(at)) ? Date.parse(at) : -Infinity;
  return events.filter(event => kind === null || event.kind === kind).sort((a, b) => time(b.at) - time(a.at));
}

export function matchEvents<T extends BusRow>(events: readonly T[], query: string): T[] {
  const term = query.toLowerCase();
  return events.filter(event => event.text.toLowerCase().includes(term) || event.kind.toLowerCase().includes(term));
}

export function busFilterLabel(shown: number, total: number): string {
  return shown === total ? '' : `${shown} of ${total} events`;
}

export function isInterjection(event: BusRow): boolean { return event.kind === 'inbox'; }
