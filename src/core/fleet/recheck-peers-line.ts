/** Pure peer bus budget evidence for recheck. Grants no coordination authority. */
import type { PeerLedgerReport } from '../agentnet/peer-ledger.js';

export interface RecheckPeers {
  asOf: string;
  status: 'ok' | 'empty' | 'unavailable';
  liveRows: number;
  capacity: number;
  rateLimited: number;
  tightest: { fromAgent: string; target: string; remaining: number } | null;
  nearCap: number;
  reasons: string[];
}

export function summarizePeers(report: PeerLedgerReport): RecheckPeers {
  const pair = report.pairs[0];
  return {
    asOf: report.asOf, status: report.status, liveRows: report.liveRows, capacity: report.capacity,
    rateLimited: report.pairs.filter(p => p.remaining === 0).length,
    tightest: pair ? { fromAgent: pair.fromAgent, target: pair.target, remaining: pair.remaining } : null,
    nearCap: report.origins.filter(o => o.nearCap).length,
    reasons: report.reason ? [report.reason] : [],
  };
}

/** Bound each scrubbed label so counts always fit on the single evidence line. */
export function formatPeersLine(
  p: RecheckPeers | null | undefined,
  scrub: (s: string) => string,
): string | null {
  if (p == null) return null;
  const clean = (s: string, max: number): string => scrub(s).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, max);
  if (p.status === 'empty') return 'Peers: none in 24h';
  if (p.status === 'unavailable') return `Peers: unknown (${clean(p.reasons[0] ?? 'no peer evidence', 180)})`;
  const pair = p.tightest;
  const tightest = pair === null ? ''
    : ` (${clean(pair.fromAgent, 40)} → ${clean(pair.target, 40)}, ${pair.remaining} left)`;
  return `Peers: ${p.liveRows}/${p.capacity} rows · ${p.rateLimited} rate-limited${tightest} · ${p.nearCap} near hop cap`;
}
