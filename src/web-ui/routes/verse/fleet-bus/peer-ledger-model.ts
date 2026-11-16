/** Narrows the untrusted peer-ledger envelope. Display only; grants no authority. */
export type PeerLedgerStatus = 'ok' | 'empty' | 'unavailable';
export interface PeerLedgerPair { fromAgent: string; target: string; inWindow: number; remaining: number; lastAt: string }
export interface PeerLedgerOrigin { origin: string; maxHop: number; nearCap: boolean }
export interface PeerLedgerView {
  status: PeerLedgerStatus;
  reason: string;
  liveRows: number;
  capacity: number;
  pairLimit: number;
  maxHops: number;
  pairs: PeerLedgerPair[];
  origins: PeerLedgerOrigin[];
}

const STATUSES: readonly string[] = ['ok', 'empty', 'unavailable'];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max = 64): string | null => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max) : null;

export function parsePeerLedger(body: unknown): PeerLedgerView | null {
  if (!record(body) || body.v !== 1 || body.authority !== 'none' || !record(body.report)) return null;
  const r = body.report;
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return null;
  const status = r.status as PeerLedgerStatus;
  const nums = [count(r.liveRows), count(r.capacity), count(r.pairLimit), count(r.maxHops)];
  if (status !== 'unavailable' && nums.includes(null)) return null;
  const [liveRows, capacity, pairLimit, maxHops] = nums.map(n => n ?? 0) as [number, number, number, number];
  const pairs = (Array.isArray(r.pairs) ? r.pairs : []).flatMap((p): PeerLedgerPair[] => {
    if (!record(p)) return [];
    const fromAgent = text(p.fromAgent), target = text(p.target), lastAt = text(p.lastAt);
    const inWindow = count(p.inWindow), remaining = count(p.remaining);
    return fromAgent && target && lastAt !== null && inWindow !== null && remaining !== null
      ? [{ fromAgent, target, inWindow, remaining, lastAt }] : [];
  });
  const origins = (Array.isArray(r.origins) ? r.origins : []).flatMap((o): PeerLedgerOrigin[] => {
    if (!record(o)) return [];
    const origin = text(o.origin), maxHop = count(o.maxHop);
    return origin && maxHop !== null && typeof o.nearCap === 'boolean' ? [{ origin, maxHop, nearCap: o.nearCap }] : [];
  });
  return { status, reason: text(r.reason) ?? '', liveRows, capacity, pairLimit, maxHops, pairs, origins };
}

/** Pairs that have spent any of their send budget, tightest first. */
export function pairsNearLimit(view: PeerLedgerView): PeerLedgerPair[] {
  return view.pairs.filter(p => p.remaining < view.pairLimit).sort((a, b) => a.remaining - b.remaining);
}

export function peerLedgerHeadline(view: PeerLedgerView): string {
  if (view.status === 'unavailable') return `Peer bus: unknown (${view.reason || 'no reason given'})`;
  if (view.status === 'empty') return 'Peer bus: no live peer traffic';
  const atLimit = view.pairs.filter(p => p.remaining <= 0).length;
  const hot = view.origins.filter(o => o.nearCap).length;
  const parts = [`${view.liveRows} of ${view.capacity} rows`];
  if (atLimit) parts.push(`${atLimit} ${atLimit === 1 ? 'pair' : 'pairs'} at limit`);
  if (hot) parts.push(`${hot} ${hot === 1 ? 'thread' : 'threads'} near hop cap`);
  return `Peer bus: ${parts.join(' · ')}`;
}
