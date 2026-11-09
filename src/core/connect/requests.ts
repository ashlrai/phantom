/**
 * core/connect/requests.ts: connect request and grant lifecycle.
 *
 * A request is created by `phm connect request` (agent-native) or by the
 * wizard as 'operator'. It stays `pending` until a human decides:
 * `approve` (creates a grant) or `deny`. There is no auto-approval path and
 * no flag that skips approval: the only transition out of `pending` is an
 * explicit operator action recorded with an audit entry.
 */

import { randomBytes } from 'node:crypto';
import { scrubSecrets } from '../util/scrub.js';
import type {
  ConnectGrant,
  ConnectRequest,
  ConnectServiceId,
  ConnectStore,
  ConnectTransferMethod,
} from './types.js';
import { CONNECT_NODE_ID_RE } from './types.js';
import { isConnectServiceId } from './services.js';

function newId(prefix: 'con_req' | 'con_gr'): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

/**
 * Resolve a node id. `local` (or the local hostname) names this machine.
 * Returns the canonical id, or null when the input cannot name a node.
 */
export function resolveNodeId(input: string | null | undefined, hostname: string): string | null {
  if (input === null || input === undefined || input === '' || input === 'local') {
    const host = hostname.trim().toLowerCase();
    return CONNECT_NODE_ID_RE.test(host) ? host : 'local';
  }
  const id = input.trim().toLowerCase();
  return CONNECT_NODE_ID_RE.test(id) ? id : null;
}

export function isLocalNode(node: string, hostname: string): boolean {
  return node === 'local' || node === hostname.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface CreateRequestInput {
  service: string;
  node: string;
  scopes?: readonly string[];
  method?: ConnectTransferMethod | null;
  requestedBy: 'agent' | 'operator';
  now: Date;
}

export function createConnectRequest(
  store: ConnectStore,
  input: CreateRequestInput,
): { ok: true; request: ConnectRequest; deduplicated: boolean } | { ok: false; reason: string } {
  if (!isConnectServiceId(input.service)) {
    return { ok: false, reason: `unknown service "${input.service}"` };
  }
  if (!CONNECT_NODE_ID_RE.test(input.node)) {
    return { ok: false, reason: `invalid node id "${input.node}"` };
  }
  // One pending request per service+node: a second ask returns the first.
  const existing = store.requests.find(
    (r) => r.status === 'pending' && r.service === input.service && r.node === input.node,
  );
  if (existing) {
    return { ok: true, request: existing, deduplicated: true };
  }
  const request: ConnectRequest = {
    schemaVersion: 1,
    id: newId('con_req'),
    service: input.service as ConnectServiceId,
    node: input.node,
    scopes: [...(input.scopes ?? [])],
    requestedMethod: input.method ?? null,
    requestedBy: input.requestedBy,
    requestedAt: input.now.toISOString(),
    status: 'pending',
    resolvedAt: null,
    grantId: null,
    note: null,
  };
  store.requests.push(request);
  return { ok: true, request, deduplicated: false };
}

export function findConnectRequest(store: ConnectStore, idOrPrefix: string): ConnectRequest | null {
  const exact = store.requests.find((r) => r.id === idOrPrefix);
  if (exact) return exact;
  const matches = store.requests.filter((r) => r.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0]! : null;
}

export function pendingConnectRequests(store: ConnectStore): ConnectRequest[] {
  return store.requests.filter((r) => r.status === 'pending');
}

export function denyConnectRequest(
  request: ConnectRequest,
  now: Date,
  note: string | null,
): void {
  request.status = 'denied';
  request.resolvedAt = now.toISOString();
  // Operator notes are persisted and later re-printed by `connect requests`;
  // scrub defensively so a stray token-shaped paste never round-trips.
  request.note = note === null ? null : scrubSecrets(note).slice(0, 512);
}

export function approveConnectRequest(
  request: ConnectRequest,
  grant: ConnectGrant,
  now: Date,
): void {
  request.status = 'approved';
  request.resolvedAt = now.toISOString();
  request.grantId = grant.id;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export function newGrantId(): string {
  return newId('con_gr');
}

export function findConnectGrant(store: ConnectStore, idOrPrefix: string): ConnectGrant | null {
  const exact = store.grants.find((g) => g.id === idOrPrefix);
  if (exact) return exact;
  const matches = store.grants.filter((g) => g.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0]! : null;
}

export function activeConnectGrant(
  store: ConnectStore,
  service: ConnectServiceId,
  node: string,
): ConnectGrant | null {
  return store.grants.find((g) => g.service === service && g.node === node && g.revokedAt === null) ?? null;
}

export function revokeConnectGrant(grant: ConnectGrant, now: Date, reason: string | null): void {
  grant.revokedAt = now.toISOString();
  grant.revokedReason = reason === null ? null : scrubSecrets(reason).slice(0, 512);
}
