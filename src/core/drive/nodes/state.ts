import type { LeaderLease, NodeSession, QueueJobV1 } from './queue-v1.js';

/** Local-auth status as observed by the node itself; never a credential. */
export type NodeAuth = 'ok' | 'missing' | 'unknown';

export interface NodeRecord extends NodeSession {
  heartbeatAt: number;
  expiresAt: number;
  /** Owner scopes this node belongs to. */
  owners?: string[];
  /** Advertised capabilities. */
  caps?: string[];
  /** Live load in permille (0-1000), self-reported on each heartbeat. */
  usage?: number;
  auth?: NodeAuth;
}

export interface NodesState {
  version: 'drive.nodes.v1';
  sequence: number;
  observedAt: number;
  nodes: NodeRecord[];
  leader: LeaderLease | null;
  jobs: QueueJobV1[];
}

export function emptyState(): NodesState {
  return { version: 'drive.nodes.v1', sequence: 0, observedAt: 0, nodes: [], leader: null, jobs: [] };
}

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value);
}

export function validCap(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(value);
}

/** Secret references are SCREAMING_SNAKE names, which keeps pasted values out. */
export function validSecretName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function list(value: unknown, ok: (v: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(ok) && new Set(value).size === value.length;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reject corrupt or unknown authority state, never reset its fencing counter. */
export function parseState(value: unknown): NodesState {
  const fail = (): never => { throw new Error('Invalid drive nodes state'); };
  if (!object(value) || value.version !== 'drive.nodes.v1' || !integer(value.sequence) ||
      !integer(value.observedAt) || !Array.isArray(value.nodes) || !Array.isArray(value.jobs)) return fail();
  const sequence = value.sequence;
  const token = (v: unknown): boolean => integer(v) && v > 0 && v <= sequence;
  const session = (v: Record<string, unknown>): boolean => validId(v.nodeId) && token(v.session);
  const lease = (v: Record<string, unknown>): boolean => session(v) && token(v.token) && integer(v.expiresAt);
  if (!value.nodes.every(n => object(n) && session(n) && integer(n.heartbeatAt) && integer(n.expiresAt) &&
    (n.owners === undefined || list(n.owners, validId)) && (n.caps === undefined || list(n.caps, validCap)) &&
    (n.usage === undefined || (integer(n.usage) && n.usage <= 1000)) &&
    (n.auth === undefined || ['ok', 'missing', 'unknown'].includes(String(n.auth))))) return fail();
  if (new Set(value.nodes.map(n => n.nodeId)).size !== value.nodes.length) return fail();
  if (value.leader !== null && (!object(value.leader) || !lease(value.leader))) return fail();
  if (!value.jobs.every(j => object(j) && validId(j.id) &&
    (j.owner === undefined || validId(j.owner)) && (j.requires === undefined || list(j.requires, validCap)) &&
    (j.pack === undefined || validId(j.pack)) && (j.secrets === undefined || list(j.secrets, validSecretName)) &&
    ['pending', 'running', 'completed'].includes(String(j.state)) &&
    (j.result === undefined || typeof j.result === 'string') &&
    (j.state !== 'completed' || typeof j.result === 'string') &&
    (j.state === 'pending' ? j.claim === undefined : object(j.claim) && lease(j.claim) &&
      j.claim.jobId === j.id && token(j.claim.leaderToken)))) return fail();
  if (new Set(value.jobs.map(j => j.id)).size !== value.jobs.length) return fail();
  return value as unknown as NodesState;
}

export interface NodesStore {
  /** Synchronous, serializable, durable on success; throw without resetting on failure. */
  transaction<T>(fn: (state: NodesState) => T): T;
}
