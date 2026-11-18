/**
 * core/fleet/node-reach-view.ts: one read-only row per known fleet computer
 * with its role, last-seen time and a reachable / stale / unknown state.
 *
 * It only merges records master already stores (the leader lease, the pool
 * standby and the joined node heartbeats in the nodes registry). It never calls
 * tailscale, ssh or the network. A node with no timestamp is "unknown", never
 * "offline". Labels drop IPs, tailnet domain suffixes and user@ prefixes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { parseState } from '../drive/nodes/state.js';

export const NODE_REACH_FRESH_MS = 120_000;
export type NodeReachRole = 'leader' | 'standby' | 'worker';
export type NodeReachState = 'reachable' | 'stale' | 'unknown';
export type NodeReachSource = 'lease' | 'standby' | 'joined';
export interface NodeReachRecord { node: string; at: number | string | null; role?: NodeReachRole }
export interface NodeReachSources { lease?: NodeReachRecord | null; standby?: NodeReachRecord | null; joined?: readonly NodeReachRecord[] }
export interface NodeReachRow { label: string; role: NodeReachRole; lastSeenIso: string | null; state: NodeReachState; source: NodeReachSource }

const ROLE_RANK: Record<NodeReachRole, number> = { leader: 2, standby: 1, worker: 0 };
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

/** "me@Fake-Node.tail0000.ts.net" becomes "fake-node"; an IP-only label becomes "unknown-node". */
export function sanitizeNodeLabel(raw: string): string {
  const noUser = raw.trim().replace(/^.*@/, '').replace(IPV4, '').replace(IPV6, '');
  const host = noUser.replace(/\.ts\.net\.?$/i, '').split('.')[0] ?? '';
  const label = host.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).toLowerCase();
  return label === '' ? 'unknown-node' : label;
}

function toMs(at: number | string | null | undefined): number | null {
  const ms = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms > 0 && Math.abs(ms) <= 8.64e15 ? ms : null;
}

export function nodeReachView(sources: NodeReachSources, now: number): NodeReachRow[] {
  const merged = new Map<string, { role: NodeReachRole; ms: number | null; source: NodeReachSource }>();
  const add = (rec: NodeReachRecord | null | undefined, source: NodeReachSource, role: NodeReachRole): void => {
    if (!rec || typeof rec.node !== 'string') return;
    const label = sanitizeNodeLabel(rec.node);
    const ms = toMs(rec.at);
    const next = { role: rec.role ?? role, ms, source };
    const cur = merged.get(label);
    if (!cur) { merged.set(label, next); return; }
    // Newest time wins; the strongest role is kept, whichever source carried it.
    const newer = ms !== null && (cur.ms === null || ms > cur.ms);
    merged.set(label, {
      role: ROLE_RANK[next.role] > ROLE_RANK[cur.role] ? next.role : cur.role,
      ms: newer ? ms : cur.ms,
      source: newer ? source : cur.source,
    });
  };
  add(sources.lease, 'lease', 'leader');
  add(sources.standby, 'standby', 'standby');
  for (const rec of sources.joined ?? []) add(rec, 'joined', 'worker');
  return [...merged.entries()].map(([label, v]): NodeReachRow => ({
    label, role: v.role, source: v.source,
    // A future-dated time cannot prove reachability; it reads as unknown.
    lastSeenIso: v.ms === null || v.ms > now ? null : new Date(v.ms).toISOString(),
    state: v.ms === null || v.ms > now ? 'unknown' : now - v.ms <= NODE_REACH_FRESH_MS ? 'reachable' : 'stale',
  })).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.label.localeCompare(b.label));
}

/** Reads the existing nodes registry file only; any failure yields no sources. */
export function readNodeReachSources(dir: string = join(ashlrHome(), 'nodes')): NodeReachSources {
  try {
    const state = parseState(JSON.parse(readFileSync(join(dir, 'nodes.json'), 'utf8')));
    const joined = state.nodes.map((n): NodeReachRecord => ({ node: n.nodeId, at: n.heartbeatAt }));
    const holder = state.leader ? state.nodes.find((n) => n.nodeId === state.leader?.nodeId) : undefined;
    const backup = state.pool?.backup;
    return {
      lease: state.leader ? { node: state.leader.nodeId, at: holder?.heartbeatAt ?? null } : null,
      standby: backup ? { node: backup, at: state.nodes.find(n => n.nodeId === backup)?.heartbeatAt ?? null } : null,
      joined,
    };
  } catch { return {}; }
}
