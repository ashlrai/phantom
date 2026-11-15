/** Read-only, metadata-only view of the peer bus budget. Grants no authority and never writes. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS, rowSchema } from './peer-bus.js';
import { agentnetPaths, readPeerJson } from './slack-identities.js';

const CAPACITY = 1024, LIVE_MS = 86_400_000, MAX_PAIRS = 64, MAX_ORIGINS = 32;

export interface PeerLedgerReport {
  v: 1; authority: 'none'; status: 'ok' | 'empty' | 'unavailable'; reason?: string; asOf: string;
  liveRows: number; capacity: number; windowMs: number; pairLimit: number; maxHops: number;
  pairs: Array<{ fromAgent: string; target: string; inWindow: number; remaining: number; lastAt: string }>;
  origins: Array<{ origin: string; maxHop: number; nearCap: boolean }>;
  truncated: { pairs: boolean; origins: boolean };
}

function base(now: number): PeerLedgerReport {
  return { v: 1, authority: 'none', status: 'empty', asOf: new Date(Number.isFinite(now) ? now : 0).toISOString(),
    liveRows: 0, capacity: CAPACITY, windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
    pairs: [], origins: [], truncated: { pairs: false, origins: false } };
}

export function readPeerLedger(options: { busRoot?: string; now?: () => number } = {}): PeerLedgerReport {
  let now: number;
  try { now = (options.now ?? Date.now)(); } catch { now = Number.NaN; }
  if (!Number.isSafeInteger(now) || now < 0) return { ...base(0), status: 'unavailable', reason: 'invalid-clock' };
  const report = base(now);
  try {
    const busRoot = options.busRoot ?? agentnetPaths().busRoot, file = join(busRoot, 'agentnet', 'coordination.json');
    if (!existsSync(file)) return report;
    const rows = z.array(rowSchema).max(CAPACITY).parse(readPeerJson(file, busRoot));
    if (rows.some(r => r.at > now)) return { ...report, status: 'unavailable', reason: 'peer-clock-reversed' };
    const live = rows.filter(r => now - r.at < LIVE_MS);
    const pairs = new Map<string, { fromAgent: string; target: string; inWindow: number; last: number }>();
    const origins = new Map<string, number>();
    for (const r of live) {
      const key = JSON.stringify([r.fromAgent, r.target]);
      const p = pairs.get(key) ?? { fromAgent: r.fromAgent, target: r.target, inWindow: 0, last: 0 };
      if (now - r.at < PEER_WINDOW_MS) p.inWindow++;
      p.last = Math.max(p.last, r.at);
      pairs.set(key, p);
      origins.set(r.origin, Math.max(origins.get(r.origin) ?? 0, r.hopCount));
    }
    const pairList = [...pairs.values()].map(p => ({ fromAgent: p.fromAgent, target: p.target, inWindow: p.inWindow,
      remaining: Math.max(0, PEER_PAIR_LIMIT - p.inWindow), lastAt: new Date(p.last).toISOString() }))
      .sort((a, b) => a.remaining - b.remaining || a.fromAgent.localeCompare(b.fromAgent) || a.target.localeCompare(b.target));
    const originList = [...origins].map(([origin, maxHop]) => ({ origin, maxHop, nearCap: maxHop >= PEER_MAX_HOPS - 1 }))
      .sort((a, b) => b.maxHop - a.maxHop || a.origin.localeCompare(b.origin));
    return { ...report, status: live.length ? 'ok' : 'empty', liveRows: live.length,
      pairs: pairList.slice(0, MAX_PAIRS), origins: originList.slice(0, MAX_ORIGINS),
      truncated: { pairs: pairList.length > MAX_PAIRS, origins: originList.length > MAX_ORIGINS } };
  } catch { return { ...report, status: 'unavailable', reason: 'peer-ledger-unreadable' }; }
}
