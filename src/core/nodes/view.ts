/**
 * Nodes view: one deterministic, secret-free snapshot (`phantom.nodes.v1`) of
 * the computers that have joined this Phantom fleet.
 *
 * Sources, all local and read-only:
 *   - `<ASHLR_HOME>/nodes/nodes.json`   the drive-nodes registry written by
 *     `phm node join|beat|leave` (roles derive from the leader lease and the
 *     designated pool backup; caps, usage, slots and gh-auth state come from
 *     each node's own heartbeat record).
 *   - this machine, from the daemon liveness proof, as node `local`.
 *
 * Auth stays on each node. A registry record may say `auth: "ok"`, never carry
 * a credential: the raw document is scanned for token-shaped strings before
 * `parseState` validation, and a hit drops the whole file and is reported by
 * name only. Output is sorted and time comes from the injected `nowMs`, so
 * equal inputs give equal bytes.
 */
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { probeDaemonLiveness } from '../daemon/liveness.js';
import { parseState, type NodesState } from '../drive/nodes/state.js';

export const NODES_SCHEMA = 'phantom.nodes.v1';
/** Heartbeat older than this is `stale`; older than DOWN_MS is `down`. */
export const NODE_STALE_MS = 90_000;
export const NODE_DOWN_MS = 300_000;

export type NodeStatus = 'ready' | 'stale' | 'down' | 'unknown';
export type NodeRole = 'leader' | 'worker' | 'standby';
/** Mirrors `NodeAuth` in drive/nodes/state.ts: a state word, never a credential. */
export type GhAuthState = 'ok' | 'missing' | 'unknown';

export interface NodeRow {
  id: string;
  role: NodeRole;
  owners: string[];
  caps: string[];
  status: NodeStatus;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  liveJobs: string[];
  ghAuth: GhAuthState;
  leader: boolean;
  source: 'local' | 'registry';
}

export interface NodeProblem { file: string; problem: string; fix: string }

export interface NodesSnapshot {
  schema: typeof NODES_SCHEMA;
  generatedAt: string;
  leaderId: string | null;
  nodes: NodeRow[];
  problems: NodeProblem[];
}

export interface NodesDeps {
  nowMs?: number;
  /** Defaults to `<ASHLR_HOME>/nodes` (the directory holding `nodes.json`). */
  dir?: string;
  /** Defaults to the real daemon liveness probe; `null` omits the local node. */
  local?: NodeRow | null;
}

const TOKEN_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|bearer\s+\S{16,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{48,}={0,2})/i;

function hasTokenShape(value: unknown): boolean {
  if (typeof value === 'string') return TOKEN_RE.test(value);
  if (Array.isArray(value)) return value.some(hasTokenShape);
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => TOKEN_RE.test(k) || hasTokenShape(v));
  return false;
}

function statusOf(ageMs: number | null, expiresAt: number, nowMs: number): NodeStatus {
  if (ageMs === null) return 'unknown';
  if (expiresAt <= nowMs || ageMs > NODE_DOWN_MS) return 'down';
  return ageMs > NODE_STALE_MS ? 'stale' : 'ready';
}

/** This machine, proven by the daemon lock heartbeat. Reads no credentials. */
export function localNodeRow(nowMs: number): NodeRow {
  const live = probeDaemonLiveness({ nowMs });
  const age = live.alive && live.lock ? live.lock.heartbeatAgeMs : null;
  return {
    id: 'local', role: 'worker', owners: [], caps: [`arch:${arch()}`, `os:${platform()}`],
    status: live.alive ? statusOf(age, Number.POSITIVE_INFINITY, nowMs) : live.alive === false ? 'down' : 'unknown',
    heartbeatAt: live.alive && live.lock ? live.lock.heartbeatAt : null, heartbeatAgeMs: age,
    liveJobs: [], ghAuth: 'unknown', leader: false, source: 'local',
  };
}

/** The live leader lease holder, mirroring DriveNodes.liveLeader: unexpired
 * lease whose holder node is live under the same session. */
function liveLeaderId(state: NodesState, nowMs: number): string | null {
  const lease = state.leader;
  if (!lease || lease.expiresAt <= nowMs) return null;
  const holder = state.nodes.find(n => n.nodeId === lease.nodeId && n.session === lease.session && n.expiresAt > nowMs);
  return holder ? lease.nodeId : null;
}

function registryRows(state: NodesState, nowMs: number): { rows: NodeRow[]; leaderId: string | null } {
  const leaderId = liveLeaderId(state, nowMs);
  // A node holding a dead leader lease, or the designated pool backup, reads as standby.
  const standbyIds = new Set<string>();
  if (state.pool) standbyIds.add(state.pool.backup);
  if (state.leader && state.leader.nodeId !== leaderId) standbyIds.add(state.leader.nodeId);
  const runningByNode = new Map<string, string[]>();
  for (const job of state.jobs) {
    const claim = job.claim;
    if (job.state === 'running' && claim && claim.expiresAt > nowMs) {
      const list = runningByNode.get(claim.nodeId) ?? [];
      list.push(job.id);
      runningByNode.set(claim.nodeId, list);
    }
  }
  const rows = state.nodes.map((n): NodeRow => {
    const age = Math.max(0, nowMs - n.heartbeatAt);
    const liveJobs = (runningByNode.get(n.nodeId) ?? []).sort();
    const role: NodeRole = n.nodeId === leaderId ? 'leader' : standbyIds.has(n.nodeId) ? 'standby' : 'worker';
    return {
      id: n.nodeId,
      role,
      owners: [...(n.owners ?? [])].sort(),
      caps: [...(n.caps ?? [])].sort(),
      status: statusOf(age, n.expiresAt, nowMs),
      heartbeatAt: new Date(n.heartbeatAt).toISOString(),
      heartbeatAgeMs: age,
      liveJobs,
      ghAuth: n.auth ?? 'unknown',
      leader: n.nodeId === leaderId,
      source: 'registry',
    };
  });
  return { rows, leaderId };
}

function readRegistry(dir: string, problems: NodeProblem[]): NodesState | null {
  const file = 'nodes.json';
  let text: string;
  try {
    text = readFileSync(join(dir, file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push({ file, problem: `cannot read the registry (${(err as NodeJS.ErrnoException).code ?? 'error'})`, fix: 'Check permissions on the nodes directory under ~/.ashlr, or set ASHLR_HOME to a readable path.' });
    }
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    problems.push({ file, problem: 'not valid JSON', fix: `Delete ${file} or rewrite it as JSON; live nodes rewrite it on their next heartbeat.` });
    return null;
  }
  if (hasTokenShape(raw)) {
    problems.push({
      file,
      problem: 'contains a token-shaped value, so the registry was dropped unread',
      fix: `Remove credentials from ${file}. A node reports only its own auth state (auth: ok|missing|unknown); log in on that node instead of copying tokens.`,
    });
    return null;
  }
  try {
    return parseState(raw);
  } catch {
    problems.push({ file, problem: 'failed registry validation', fix: `Rewrite ${file} through \`phm node join\`/\`phm node beat\` or delete it while no node is running; it is rebuilt from heartbeats.` });
    return null;
  }
}

export function buildNodesSnapshot(deps: NodesDeps = {}): NodesSnapshot {
  const nowMs = deps.nowMs ?? Date.now();
  const dir = deps.dir ?? join(ashlrHome(), 'nodes');
  const problems: NodeProblem[] = [];
  const byId = new Map<string, NodeRow>();
  const state = readRegistry(dir, problems);
  let leaderId: string | null = null;
  if (state) {
    const { rows, leaderId: live } = registryRows(state, nowMs);
    leaderId = live;
    for (const row of rows) byId.set(row.id, row);
  }
  const local = deps.local === undefined ? localNodeRow(nowMs) : deps.local;
  if (local && !byId.has(local.id)) byId.set(local.id, local);
  const nodes = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { schema: NODES_SCHEMA, generatedAt: new Date(nowMs).toISOString(), leaderId, nodes, problems };
}
