import type { Unknown } from './runtime-identity-model.js';

/** View model for GET /api/verse/fleet/tailnet-peers. Declared here on purpose: the route is a separate change. */
export interface TailnetPeerRow {
  name: string;
  os: string;
  online: boolean | Unknown;
  lastSeen: string;
  ageSeconds: number | Unknown;
}
export interface TailnetPeersView {
  asOf: string;
  self: string;
  peers: TailnetPeerRow[];
  /** Peer rows dropped because they were malformed. */
  dropped: number;
  reasons: string[];
}

export const MAX_PEER_ROWS = 64;
export const MAX_TEXT = 120;

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : 'unknown');

export function narrowTailnetPeers(raw: unknown): TailnetPeersView | null {
  if (!object(raw)) return null;
  const rows = Array.isArray(raw.peers) ? raw.peers : [];
  const peers: TailnetPeerRow[] = [];
  let dropped = 0;
  for (const row of rows.slice(0, MAX_PEER_ROWS)) {
    if (!object(row) || typeof row.name !== 'string' || row.name === '') { dropped += 1; continue; }
    peers.push({
      name: text(row.name),
      os: text(row.os),
      online: typeof row.online === 'boolean' ? row.online : 'unknown',
      lastSeen: text(row.lastSeen),
      ageSeconds: typeof row.ageSeconds === 'number' && Number.isFinite(row.ageSeconds) && row.ageSeconds >= 0 ? row.ageSeconds : 'unknown',
    });
  }
  return {
    asOf: text(raw.asOf),
    self: text(raw.self),
    peers,
    dropped,
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter((r): r is string => typeof r === 'string' && r !== '').map((r) => r.slice(0, MAX_TEXT))
      : [],
  };
}

export function summarizePeers(view: TailnetPeersView): { online: number; offline: number; unknown: number } {
  const out = { online: 0, offline: 0, unknown: 0 };
  for (const p of view.peers) {
    if (p.online === true) out.online += 1;
    else if (p.online === false) out.offline += 1;
    else out.unknown += 1;
  }
  return out;
}

/** Age of the snapshot relative to `nowMs`, or 'unknown' when asOf is not a parseable time. */
export function snapshotAge(asOf: string, nowMs: number): number | Unknown {
  const t = Date.parse(asOf);
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : 'unknown';
}
