import type { BusHop } from '../fleet/bus-feed-queries.js';

export interface BusMapAgent {
  id: string;
  sent: number;
  received: number;
  /** Token sums over the hops this agent SENT (the sender pays); null = every count unknown or overflow. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface BusMapPair {
  from: string;
  to: string;
  hops: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Fraction of all hops this directed pair carries (0–1); 0 when there are no hops. */
  share: number;
}

export interface BusMapTotals {
  hops: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface BusMap {
  agents: BusMapAgent[];
  pairs: BusMapPair[];
  totals: BusMapTotals;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sum of the known counts: nulls are skipped (missing usage is unknown, never
 * an invented zero), so the result is null when every count is unknown — and
 * null again when the running total would leave safe-integer range.
 */
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

const agentOrder = (a: BusMapAgent, b: BusMapAgent): number =>
  (b.sent + b.received) - (a.sent + a.received) || byId(a.id, b.id);

/**
 * Aggregate the bounded tail of hop-log rows into per-agent and per-pair
 * traffic. Both lists are fully ordered (traffic desc, id asc on ties) so the
 * rendered table never jitters between polls. Numbers describe the recent
 * window only — the API serves a bounded tail, not lifetime totals.
 */
export function buildBusMap(hops: readonly BusHop[]): BusMap {
  const agentAcc = new Map<string, { sent: number; received: number; sentHops: BusHop[] }>();
  // Nested maps: ids are any printable string, so no composed key is safe.
  const pairAcc = new Map<string, Map<string, BusHop[]>>();
  const agent = (id: string) => {
    let entry = agentAcc.get(id);
    if (!entry) {
      entry = { sent: 0, received: 0, sentHops: [] };
      agentAcc.set(id, entry);
    }
    return entry;
  };
  for (const hop of hops) {
    const sender = agent(hop.from);
    sender.sent += 1;
    sender.sentHops.push(hop);
    agent(hop.to).received += 1;
    let dests = pairAcc.get(hop.from);
    if (!dests) {
      dests = new Map<string, BusHop[]>();
      pairAcc.set(hop.from, dests);
    }
    const pair = dests.get(hop.to);
    if (pair) pair.push(hop);
    else dests.set(hop.to, [hop]);
  }
  const agents = [...agentAcc].map(([id, acc]): BusMapAgent => ({
    id,
    sent: acc.sent,
    received: acc.received,
    inputTokens: sumTokens(acc.sentHops, 'inputTokens'),
    outputTokens: sumTokens(acc.sentHops, 'outputTokens'),
  })).sort(agentOrder);
  const pairs = [...pairAcc].flatMap(([from, dests]) =>
    [...dests].map(([to, pairHops]): BusMapPair => ({
      from,
      to,
      hops: pairHops.length,
      inputTokens: sumTokens(pairHops, 'inputTokens'),
      outputTokens: sumTokens(pairHops, 'outputTokens'),
      share: hops.length > 0 ? pairHops.length / hops.length : 0,
    })),
  ).sort((a, b) => b.hops - a.hops || byId(a.from, b.from) || byId(a.to, b.to));
  return {
    agents,
    pairs,
    totals: {
      hops: hops.length,
      inputTokens: sumTokens(hops, 'inputTokens'),
      outputTokens: sumTokens(hops, 'outputTokens'),
    },
  };
}

/**
 * Shorten an id for display: keep the start AND the end with a middle
 * ellipsis ('…'), max chars total. Ids are shown as text only — this is
 * presentation, never a lookup key; callers keep the full id in `title`.
 */
export function truncateAgentId(id: string, max = 24): string {
  const limit = Math.max(0, Math.floor(max));
  if (id.length <= limit) return id;
  if (limit === 0) return '';
  if (limit === 1) return '…';
  const head = Math.ceil((limit - 1) / 2);
  const tail = limit - 1 - head;
  return `${id.slice(0, head)}…${tail > 0 ? id.slice(id.length - tail) : ''}`;
}

/** The `n` busiest agents (same ordering as buildBusMap), for display caps. */
export function topTalkers(agents: readonly BusMapAgent[], n: number): BusMapAgent[] {
  const limit = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return [...agents].sort(agentOrder).slice(0, limit);
}

/**
 * "last hop 3 min ago" — how fresh the bus is, from the feed's last-hop
 * stamp. "no hops recorded" when the feed has never seen a hop (or carries a
 * stamp that does not parse): the pane's empty window and a dead bus are
 * different states, and this string is what tells them apart.
 */
export function lastHopText(lastHopAt: string | null, nowMs: number): string {
  const at = lastHopAt === null ? NaN : Date.parse(lastHopAt);
  if (!Number.isFinite(at)) return 'no hops recorded';
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000));
  if (seconds < 60) return `last hop ${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last hop ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last hop ${hours} hr ago`;
  return `last hop ${Math.floor(hours / 24)} days ago`;
}
