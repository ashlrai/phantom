import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { parseState } from '../drive/nodes/state.js';

export const NODES_SCHEMA = 'phantom.nodes.v1';
export const NODE_STALE_MS = 90_000;
export const NODE_DOWN_MS = 300_000;
const secret = /(gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|xox[abprs]-[a-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|bearer\s+\S{16,}|[a-f0-9]{40,}|[a-z0-9+/_-]{48,}={0,2})/i;
function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') return secret.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => secret.test(k) || containsSecret(v));
}

export function buildNodesSnapshot(deps: { dir?: string; nowMs?: number } = {}) {
  const now = deps.nowMs ?? Date.now();
  const file = join(deps.dir ?? join(ashlrHome(), 'nodes'), 'nodes.json');
  const base = { schema: NODES_SCHEMA, generatedAt: new Date(now).toISOString(), sourcePath: file };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    return { ...base, observedAt: null, leaderId: null, nodes: [], error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'inventory missing' : 'inventory unreadable' };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return { ...base, observedAt: null, leaderId: null, nodes: [], error: 'inventory is not valid JSON' };
  }
  if (containsSecret(raw)) return { ...base, observedAt: null, leaderId: null, nodes: [], error: 'inventory contains a secret-shaped value' };
  let state;
  try { state = parseState(raw); } catch {
    return { ...base, observedAt: null, leaderId: null, nodes: [], error: 'inventory failed validation' };
  }
  const lease = state.leader;
  const leaderId = lease && lease.expiresAt > now && state.nodes.some(n => n.nodeId === lease.nodeId && n.session === lease.session && n.expiresAt > now) ? lease.nodeId : null;
  const nodes = state.nodes.map(n => {
    const age = n.heartbeatAt > 0 ? Math.max(0, now - n.heartbeatAt) : null;
    const status = age === null ? 'unknown' : n.expiresAt <= now || age > NODE_DOWN_MS ? 'down' : age > NODE_STALE_MS ? 'stale' : 'ready';
    const role = n.nodeId === leaderId ? 'leader' : n.nodeId === state.pool?.backup || n.nodeId === lease?.nodeId ? 'standby' : 'worker';
    const liveJobs = state.jobs.filter(j => j.state === 'running' && j.claim?.nodeId === n.nodeId && j.claim.session === n.session && j.claim.expiresAt > now).map(j => j.id).sort();
    return { id: n.nodeId, role, owners: [...(n.owners ?? [])].sort(), caps: [...(n.caps ?? [])].sort(), status, heartbeatAt: n.heartbeatAt ? new Date(n.heartbeatAt).toISOString() : null, heartbeatAgeMs: age, liveJobs, ghAuth: n.auth ?? 'unknown', leader: n.nodeId === leaderId, source: 'registry' };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ...base, observedAt: state.observedAt ? new Date(state.observedAt).toISOString() : null, leaderId, nodes, error: null };
}
