/**
 * Nodes view: one deterministic, secret-free snapshot (`phantom.nodes.v1`) of
 * the computers that have joined this Phantom fleet.
 *
 * Sources, all local and read-only:
 *   - `<ASHLR_HOME>/nodes/<id>.json`   one record per node, written by that
 *     node itself (role, caps, heartbeat, live jobs, gh-auth heartbeat state).
 *   - `<ASHLR_HOME>/nodes/leader-lease.json`   the fleet lease: `holder`,
 *     `generation`, `expiresAt`. The leader badge goes to the holder only while
 *     the lease is unexpired and the holder's own heartbeat is not down.
 *   - this machine, from the daemon liveness proof, as node `local`.
 *
 * Auth stays on each node. A record may say `ghAuth: "ok"`, never carry a
 * credential: parsing is a strict allow-list, and any record holding a
 * token-shaped string is dropped whole and reported by file name only.
 * Output is sorted and time comes from the injected `nowMs`, so equal inputs
 * give equal bytes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { probeDaemonLiveness } from '../daemon/liveness.js';

export const NODES_SCHEMA = 'phantom.nodes.v1';
/** Heartbeat older than this is `stale`; older than DOWN_MS is `down`. */
export const NODE_STALE_MS = 90_000;
export const NODE_DOWN_MS = 300_000;

export type NodeStatus = 'ready' | 'stale' | 'down' | 'unknown';
export type NodeRole = 'leader' | 'worker' | 'standby';
export type GhAuthState = 'ok' | 'missing' | 'expired' | 'unknown';

export interface NodeRow {
  id: string;
  role: NodeRole;
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
  /** Defaults to `<ASHLR_HOME>/nodes`. */
  dir?: string;
  /** Defaults to the real daemon liveness probe; `null` omits the local node. */
  local?: NodeRow | null;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAP_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ROLES: readonly NodeRole[] = ['leader', 'worker', 'standby'];
const GH_STATES: readonly GhAuthState[] = ['ok', 'missing', 'expired', 'unknown'];
const MAX_CAPS = 32;
const MAX_JOBS = 64;
const TOKEN_RE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|bearer\s+\S{16,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/_-]{48,}={0,2})/i;

function hasTokenShape(value: unknown): boolean {
  if (typeof value === 'string') return TOKEN_RE.test(value);
  if (Array.isArray(value)) return value.some(hasTokenShape);
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => TOKEN_RE.test(k) || hasTokenShape(v));
  return false;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function statusOf(ageMs: number | null): NodeStatus {
  if (ageMs === null) return 'unknown';
  return ageMs > NODE_DOWN_MS ? 'down' : ageMs > NODE_STALE_MS ? 'stale' : 'ready';
}

function stringList(value: unknown, re: RegExp, max: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((v) => typeof v === 'string' && re.test(v))) return null;
  return [...new Set(value as string[])].sort();
}

function parseRecord(file: string, raw: unknown, nowMs: number): NodeRow | NodeProblem {
  const bad = (problem: string, fix: string): NodeProblem => ({ file, problem, fix });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('not a JSON object', `Rewrite ${file} as an object, or delete it and let the node rejoin.`);
  }
  if (hasTokenShape(raw)) {
    return bad(
      'contains a token-shaped value, so the record was dropped unread',
      `Remove credentials from ${file}. A node reports only its own auth state (ghAuth: ok|missing|expired|unknown); log in on that node instead of copying tokens.`,
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !ID_RE.test(r['id'])) {
    return bad('id is missing or not lowercase letters, digits, ".", "_" or "-"', `Set "id" in ${file} to a short name such as "mac-mini-1".`);
  }
  const role = r['role'] ?? 'worker';
  if (!ROLES.includes(role as NodeRole)) return bad(`role "${String(role)}" is not one of ${ROLES.join(', ')}`, `Set "role" in ${file} to ${ROLES.join(', ')}.`);
  const ghAuth = r['ghAuth'] ?? 'unknown';
  if (!GH_STATES.includes(ghAuth as GhAuthState)) return bad(`ghAuth "${String(ghAuth)}" is not one of ${GH_STATES.join(', ')}`, `Set "ghAuth" in ${file} to one of ${GH_STATES.join(', ')}.`);
  const caps = stringList(r['caps'], CAP_RE, MAX_CAPS);
  if (!caps) return bad(`caps must be at most ${MAX_CAPS} short names like "os:linux"`, `Fix "caps" in ${file}.`);
  const jobs = stringList(r['liveJobs'], ID_RE, MAX_JOBS);
  if (!jobs) return bad(`liveJobs must be at most ${MAX_JOBS} job ids`, `Fix "liveJobs" in ${file}.`);
  const beat = isoMs(r['heartbeatAt']);
  const age = beat === null ? null : Math.max(0, nowMs - beat);
  return {
    id: r['id'], role: role as NodeRole, caps, status: statusOf(age),
    heartbeatAt: beat === null ? null : new Date(beat).toISOString(), heartbeatAgeMs: age,
    liveJobs: jobs, ghAuth: ghAuth as GhAuthState, leader: false, source: 'registry',
  };
}

/** This machine, proven by the daemon lock heartbeat. Reads no credentials. */
export function localNodeRow(nowMs: number): NodeRow {
  const live = probeDaemonLiveness({ nowMs });
  const age = live.alive && live.lock ? live.lock.heartbeatAgeMs : null;
  return {
    id: 'local', role: 'worker', caps: [`arch:${arch()}`, `os:${platform()}`], status: live.alive ? statusOf(age) : live.alive === false ? 'down' : 'unknown',
    heartbeatAt: live.alive && live.lock ? live.lock.heartbeatAt : null, heartbeatAgeMs: age,
    liveJobs: [], ghAuth: 'unknown', leader: false, source: 'local',
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function buildNodesSnapshot(deps: NodesDeps = {}): NodesSnapshot {
  const nowMs = deps.nowMs ?? Date.now();
  const dir = deps.dir ?? join(ashlrHome(), 'nodes');
  const problems: NodeProblem[] = [];
  const byId = new Map<string, NodeRow>();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'leader-lease.json').sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push({ file: 'nodes/', problem: `cannot read the nodes directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`, fix: 'Check permissions on the nodes directory under ~/.ashlr, or set ASHLR_HOME to a readable path.' });
    }
  }
  for (const file of files) {
    let parsed: NodeRow | NodeProblem;
    try {
      parsed = parseRecord(file, readJson(join(dir, file)), nowMs);
    } catch {
      parsed = { file, problem: 'not valid JSON', fix: `Delete ${file} or rewrite it as JSON; the node rewrites it on its next heartbeat.` };
    }
    if ('problem' in parsed) problems.push(parsed);
    else if (byId.has(parsed.id)) problems.push({ file, problem: `duplicate node id "${parsed.id}"`, fix: `Give each node a unique "id"; remove or rename ${file}.` });
    else byId.set(parsed.id, parsed);
  }
  const local = deps.local === undefined ? localNodeRow(nowMs) : deps.local;
  if (local && !byId.has(local.id)) byId.set(local.id, local);

  // Leader badge: unexpired lease holder whose own heartbeat is not down.
  let leaderId: string | null = null;
  try {
    const lease = readJson(join(dir, 'leader-lease.json')) as { holder?: unknown; expiresAt?: unknown };
    const expires = isoMs(lease.expiresAt);
    if (typeof lease.holder === 'string' && expires !== null && expires > nowMs && !hasTokenShape(lease)) {
      const holder = byId.get(lease.holder);
      if (holder && holder.status !== 'down') leaderId = holder.id;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push({ file: 'leader-lease.json', problem: 'unreadable lease; no leader is shown', fix: 'Delete leader-lease.json; the leader rewrites it on its next lease renewal.' });
    }
  }
  const nodes = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((n) => {
    const leader = n.id === leaderId;
    return { ...n, leader, role: leader ? 'leader' as const : n.role === 'leader' ? 'standby' as const : n.role };
  });
  problems.sort((a, b) => a.file.localeCompare(b.file));
  return { schema: NODES_SCHEMA, generatedAt: new Date(nowMs).toISOString(), leaderId, nodes, problems };
}
