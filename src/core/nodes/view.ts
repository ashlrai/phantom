import { actionableClaim } from '../drive/nodes/router.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { liveLeader, parseState, type NodeAuth } from '../drive/nodes/state.js';
import { NODE_OFFLINE_MS } from '../drive/nodes/router.js';
import type { NodeProfile } from '../drive/nodes/profiles.js';

export const NODES_SCHEMA = 'phantom.nodes.v1';
export const NODE_STALE_MS = 90_000;
export const NODE_DOWN_MS = NODE_OFFLINE_MS;

/** `offline` is only ever reported for a declared profile node that never joined or has gone quiet. */
export type NodeStatus = 'ready' | 'stale' | 'down' | 'unknown' | 'offline';
export type NodeRole = 'leader' | 'standby' | 'worker';

/** One node's row in the phantom.nodes.v1 snapshot — the same fields `phm fleet nodes` prints. */
export interface NodeRow {
  id: string;
  role: NodeRole;
  owners: string[];
  caps: string[];
  status: NodeStatus;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  liveJobs: string[];
  ghAuth: NodeAuth;
  leader: boolean;
  source: 'registry' | 'profile';
  /** Present only when the node matches a declared profile (see drive/nodes/profiles.ts). */
  profile?: NodeProfileView;
}

export interface NodeProfileView { label: string; ramGb: number; maxCliAgents: number; localModels: boolean; memoryFloorPercent: number }
const profileView = (p: NodeProfile): NodeProfileView => ({ label: p.label, ramGb: Math.round(p.ramBytes / 1024 ** 3),
  maxCliAgents: p.maxCliAgents, localModels: p.localModels, memoryFloorPercent: p.memoryFloorPercent });

/**
 * The phantom.nodes.v1 snapshot served at GET /api/nodes and printed by
 * `phm fleet nodes --json`. Secret-free by construction: any record holding a
 * token-shaped value drops the whole snapshot to an error instead.
 */
export interface NodesSnapshot {
  schema: typeof NODES_SCHEMA;
  generatedAt: string;
  sourcePath: string;
  observedAt: string | null;
  leaderId: string | null;
  nodes: NodeRow[];
  error: string | null;
}
const secret = /(gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|xox[abprs]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|bearer\s+\S{16,}|[a-f0-9]{40,}|[a-z0-9+/_-]{48,}={0,2})/i;
function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') return secret.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => secret.test(k) || containsSecret(v));
}

export function buildNodesSnapshot(deps: { dir?: string; nowMs?: number; profiles?: readonly NodeProfile[] } = {}): NodesSnapshot {
  const now = deps.nowMs ?? Date.now();
  const profiles = deps.profiles ?? [];
  const file = join(deps.dir ?? join(ashlrHome(), 'nodes'), 'nodes.json');
  const base: Pick<NodesSnapshot, 'schema' | 'generatedAt' | 'sourcePath'> = { schema: NODES_SCHEMA, generatedAt: new Date(now).toISOString(), sourcePath: file };
  const offlineRow = (p: NodeProfile): NodeRow => ({ id: p.id, role: 'worker', owners: [...p.owners].sort(), caps: [], status: 'offline',
    heartbeatAt: null, heartbeatAgeMs: null, liveJobs: [], ghAuth: 'unknown', leader: false, source: 'profile', profile: profileView(p) });
  // A declared host is always listed, even when the inventory cannot be read, so the roster never hides it.
  const failed = (error: string): NodesSnapshot => ({ ...base, observedAt: null, leaderId: null, nodes: profiles.map(offlineRow), error });
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    return failed((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'inventory missing' : 'inventory unreadable');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return failed('inventory is not valid JSON');
  }
  if (containsSecret(raw)) return failed('inventory contains a secret-shaped value');
  let state;
  try { state = parseState(raw); } catch {
    return failed('inventory failed validation');
  }
  const lease = state.leader;
  const leaderId = liveLeader(state, now)?.nodeId ?? null;
  const active = state.jobs.filter(job => actionableClaim(state, job, now));
  const nodes = state.nodes.map((n): NodeRow => {
    const age = n.heartbeatAt > 0 ? Math.max(0, now - n.heartbeatAt) : null;
    const status = age === null || n.heartbeatAt > now ? 'unknown' : n.expiresAt <= now || age >= NODE_DOWN_MS ? 'down' : age > NODE_STALE_MS ? 'stale' : 'ready';
    const role = n.nodeId === leaderId ? 'leader' : n.nodeId === state.pool?.backup || n.nodeId === lease?.nodeId ? 'standby' : 'worker';
    const liveJobs = active.filter(j => j.claim!.nodeId === n.nodeId).map(j => j.id).sort();
    const profile = profiles.find(p => p.id === n.nodeId);
    const offline = !!profile && (status === 'down' || status === 'unknown');
    return { id: n.nodeId, role, owners: [...(n.owners ?? [])].sort(), caps: [...(n.caps ?? [])].sort(), status: offline ? 'offline' : status, heartbeatAt: n.heartbeatAt ? new Date(n.heartbeatAt).toISOString() : null, heartbeatAgeMs: age, liveJobs, ghAuth: n.auth ?? 'unknown', leader: n.nodeId === leaderId, source: 'registry', ...(profile ? { profile: profileView(profile) } : {}) };
  });
  // A declared host that never joined is still shown, as offline, so the roster does not hide it.
  for (const p of profiles) if (!nodes.some(n => n.id === p.id)) nodes.push(offlineRow(p));
  nodes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ...base, observedAt: state.observedAt ? new Date(state.observedAt).toISOString() : null, leaderId, nodes, error: null };
}
