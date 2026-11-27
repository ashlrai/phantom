/** Read-only, metadata-only view of the peer bus budget. Grants no authority and never writes. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS, rowSchema, type PeerLedgerRow } from './peer-bus.js';
import { agentnetPaths, readPeerJson } from './slack-identities.js';

export type { PeerLedgerRow };

const CAPACITY = 1024, LIVE_MS = 86_400_000, MAX_PAIRS = 64, MAX_ORIGINS = 32;

export interface PeerPairSelector { fromAgent: string; target: string }
export interface PeerLedgerSelection extends PeerPairSelector { match: 'exact' | 'none' }

/** Exact pair lookup reuses the stored row's own field validators; anything else is refused. */
export const peerPairSelectorSchema = z.object({
  fromAgent: rowSchema.shape.fromAgent, target: rowSchema.shape.target }).strict();

export interface PeerLedgerReport {
  v: 1; authority: 'none'; status: 'ok' | 'empty' | 'unavailable'; reason?: string; asOf: string;
  liveRows: number; capacity: number; windowMs: number; pairLimit: number; maxHops: number;
  pairs: Array<{ fromAgent: string; target: string; inWindow: number; remaining: number; lastAt: string; retryAt: string | null }>;
  origins: Array<{ origin: string; maxHop: number; nearCap: boolean }>;
  truncated: { pairs: boolean; origins: boolean };
  /** Present only when the caller requested an exact pair; match 'none' is not proof of enrollment or quota. */
  selection?: PeerLedgerSelection;
}

function base(now: number): PeerLedgerReport {
  return { v: 1, authority: 'none', status: 'empty', asOf: new Date(Number.isFinite(now) ? now : 0).toISOString(),
    liveRows: 0, capacity: CAPACITY, windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
    pairs: [], origins: [], truncated: { pairs: false, origins: false } };
}

export function readPeerLedger(options: { busRoot?: string; now?: () => number; pair?: PeerPairSelector } = {}): PeerLedgerReport {
  let now: number;
  try { now = (options.now ?? Date.now)(); } catch { now = Number.NaN; }
  if (!Number.isSafeInteger(now) || now < 0) return { ...base(0), status: 'unavailable', reason: 'invalid-clock' };
  const report = base(now);
  if (options.pair !== undefined) {
    const parsed = peerPairSelectorSchema.safeParse(options.pair);
    if (!parsed.success) return { ...report, status: 'unavailable', reason: 'invalid-pair-selector' };
    report.selection = { fromAgent: parsed.data.fromAgent, target: parsed.data.target, match: 'none' };
  }
  try {
    const busRoot = options.busRoot ?? agentnetPaths().busRoot, file = join(busRoot, 'agentnet', 'coordination.json');
    if (!existsSync(file)) return report;
    const rows = z.array(rowSchema).max(CAPACITY).parse(readPeerJson(file, busRoot));
    if (rows.some(r => r.at > now)) return { ...report, status: 'unavailable', reason: 'peer-clock-reversed' };
    const live = rows.filter(r => now - r.at < LIVE_MS);
    const pairs = new Map<string, { fromAgent: string; target: string; inWindow: number; last: number; ats: number[] }>();
    const origins = new Map<string, number>();
    for (const r of live) {
      const key = JSON.stringify([r.fromAgent, r.target]);
      const p = pairs.get(key) ?? { fromAgent: r.fromAgent, target: r.target, inWindow: 0, last: 0, ats: [] };
      if (now - r.at < PEER_WINDOW_MS) { p.inWindow++; p.ats.push(r.at); }
      p.last = Math.max(p.last, r.at);
      pairs.set(key, p);
      origins.set(r.origin, Math.max(origins.get(r.origin) ?? 0, r.hopCount));
    }
    const pairList = [...pairs.values()].map(p => {
      // Earliest instant the pair drops below the limit: each in-window row stops
      // debiting at at + PEER_WINDOW_MS, so with n >= limit rows the (n-limit+1)-th
      // oldest expiry is the first time fewer than limit rows remain. Null when not blocked.
      let retryAt: string | null = null;
      if (p.inWindow >= PEER_PAIR_LIMIT) {
        const ats = [...p.ats].sort((a, b) => a - b);
        retryAt = new Date(ats[p.inWindow - PEER_PAIR_LIMIT] + PEER_WINDOW_MS).toISOString();
      }
      return { fromAgent: p.fromAgent, target: p.target, inWindow: p.inWindow,
        remaining: Math.max(0, PEER_PAIR_LIMIT - p.inWindow), lastAt: new Date(p.last).toISOString(), retryAt };
    })
      .sort((a, b) => a.remaining - b.remaining || a.fromAgent.localeCompare(b.fromAgent) || a.target.localeCompare(b.target));
    const originList = [...origins].map(([origin, maxHop]) => ({ origin, maxHop, nearCap: maxHop >= PEER_MAX_HOPS - 1 }))
      .sort((a, b) => b.maxHop - a.maxHop || a.origin.localeCompare(b.origin));
    // The selector filters aggregated pairs before the display slice, so an exact
    // match is still found when the unfiltered report would truncate it away.
    const sel = report.selection;
    const shown = sel
      ? pairList.filter(p => p.fromAgent === sel.fromAgent && p.target === sel.target)
      : pairList;
    if (sel && shown.length) sel.match = 'exact';
    return { ...report, status: live.length ? 'ok' : 'empty', liveRows: live.length,
      pairs: shown.slice(0, MAX_PAIRS), origins: originList.slice(0, MAX_ORIGINS),
      truncated: { pairs: pairList.length > MAX_PAIRS, origins: originList.length > MAX_ORIGINS } };
  } catch { return { ...report, status: 'unavailable', reason: 'peer-ledger-unreadable' }; }
}

export interface PeerLedgerRowsRead {
  /** 'missing' is a verified-absent ledger; 'unavailable' means the file
   * exists but fails the same custody, shape or conflict read
   * `readPeerInbox`/`sendPeerMessage` apply — the failure that makes every
   * peer verb refuse. */
  status: 'missing' | 'available' | 'unavailable';
  /** Validated coordination rows; empty unless the ledger read cleanly. */
  rows: PeerLedgerRow[];
}

/** Row-level read of the same coordination ledger `readPeerLedger`
 * summarizes, for callers that must match individual admission rows — id,
 * target, send instant, digest — rather than count the live send budget.
 * Never throws and never writes; an absent file is 'missing' with no rows,
 * a failed read 'unavailable' with none. Rows are returned unfiltered:
 * callers apply their own liveness window exactly as `readPeerInbox` does. */
export function readPeerLedgerRows(options: { busRoot?: string } = {}): PeerLedgerRowsRead {
  try {
    const busRoot = options.busRoot ?? agentnetPaths().busRoot;
    const file = join(busRoot, 'agentnet', 'coordination.json');
    if (!existsSync(file)) return { status: 'missing', rows: [] };
    return { status: 'available',
      rows: z.array(rowSchema).max(CAPACITY).parse(readPeerJson(file, busRoot)) };
  } catch { return { status: 'unavailable', rows: [] }; }
}
