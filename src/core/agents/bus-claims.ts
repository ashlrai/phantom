/**
 * Agent Bus v2 resource claims (docs/AGENT-BUS.md, "Claim protocol").
 * `work.claim` and `work.release` bodies are operations, not mail: they run
 * against the one coordination table (claim-store.ts) so overlap with
 * message-id, team and board leases is decided in one place. Claims coordinate
 * only; they grant no execution authority. The 64-hex fencing token is returned
 * to its acquirer and never appears in a conflict holder.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { acquireCoordination, coordinationRowBlocks, listCoordination, renewCoordination, settleCoordination, type CoordinationView } from './claim-store.js';
import { parseClaimKey, workClaimBodySchema, workReleaseBodySchema, type WorkJob } from './bus-v2-schema.js';
import { readAgentRegistry, resolveAgent } from './bus-identity.js';
import { readBusWorkFeed } from './bus-work-feed-read.js';

export interface BusClaimOptions {
  /** Coordination store root; defaults to the shared fleet root. */
  root?: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
}

export interface BusClaimsListOptions {
  /** Coordination store root; defaults to the shared fleet root. */
  root?: string;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number;
  /** When set, only live claims that would block an acquire of this key. */
  key?: string;
  /**
   * When set, only live claims owned by this routing ref — a handle,
   * `agent:<handle>`, stable id or alias. A ref that resolves through the
   * identity registry matches every label of that identity; an unresolvable
   * ref, or an unreadable registry, matches the exact owner label only.
   */
  owner?: string;
  /**
   * When true, join each returned claim with the announced work-feed jobs its
   * keys block (the reverse of `work feed --claims`). Read-only; an
   * unreadable feed reports its state and leaves `jobs` absent — blocked work
   * stays unknown, never an empty list.
   */
  jobs?: boolean;
}

export type BusClaimResult =
  | { v: 2; status: 'acquired'; claim: { claimKey: string; owner: string; leaseMs: number; token: string; leaseUntil: number } }
  | { v: 2; status: 'renewed'; claim: { claimKey: string; leaseUntil: number } }
  | { v: 2; status: 'released' | 'completed'; claimKey: string }
  | { v: 2; status: 'conflict'; holder: { owner: string; claimKey: string; leaseUntil: number } }
  | { v: 2; status: 'mismatched-token' | 'expired' | 'lost' | 'invalid' | 'unavailable' | 'full' };

type WorkClaimBody = z.infer<typeof workClaimBodySchema>;
type AcquireBody = Extract<WorkClaimBody, { op: 'acquire' }>;
type RenewBody = Extract<WorkClaimBody, { op: 'renew' }>;
type ReleaseBody = z.infer<typeof workReleaseBodySchema>;

/**
 * Deterministic lease source id: a retried operation on the same claim key
 * replaces its own row instead of conflicting with it, while the same operation
 * id reused on a different key cannot silently relocate the first lease.
 */
function sourceIdFor(opId: string, claimKey: string): string {
  const digest = createHash('sha256').update(claimKey, 'utf8').digest('hex').slice(0, 16);
  return `agentbus:${opId}:${digest}`;
}

function acquire(body: AcquireBody, opId: string, options: BusClaimOptions, now: number): BusClaimResult {
  const gate = acquireCoordination({
    root: options.root, origin: 'resource', key: body.claimKey, owner: body.owner,
    leaseMs: body.leaseMs, leaseUntil: now + body.leaseMs,
    sourceId: sourceIdFor(opId, body.claimKey), now,
    started: Number.isFinite(now) ? new Date(now).toISOString() : null,
  });
  if (gate.status === 'acquired' && gate.token !== undefined && gate.leaseUntil !== undefined) {
    return { v: 2, status: 'acquired', claim: { claimKey: body.claimKey, owner: body.owner,
      leaseMs: body.leaseMs, token: gate.token, leaseUntil: gate.leaseUntil } };
  }
  if (gate.status === 'conflict') {
    return { v: 2, status: 'conflict', holder: { owner: gate.holder.owner,
      claimKey: gate.holder.key, leaseUntil: gate.holder.leaseUntil } };
  }
  if (gate.status === 'invalid' || gate.status === 'full' || gate.status === 'unavailable') {
    return { v: 2, status: gate.status };
  }
  return { v: 2, status: 'unavailable' };
}

function renew(body: RenewBody, options: BusClaimOptions, now: number): BusClaimResult {
  const gate = renewCoordination({ root: options.root, key: body.claimKey, token: body.token,
    leaseUntil: now + body.leaseMs, now });
  if (gate.status === 'renewed' && gate.leaseUntil !== undefined) {
    return { v: 2, status: 'renewed', claim: { claimKey: body.claimKey, leaseUntil: gate.leaseUntil } };
  }
  if (gate.status === 'mismatched-token' || gate.status === 'expired' || gate.status === 'lost' ||
      gate.status === 'invalid' || gate.status === 'unavailable') {
    return { v: 2, status: gate.status };
  }
  return { v: 2, status: 'unavailable' };
}

function release(body: ReleaseBody, options: BusClaimOptions, now: number): BusClaimResult {
  const gate = settleCoordination({ root: options.root, key: body.claimKey, token: body.token,
    outcome: body.outcome, now });
  if (gate.status === 'released' || gate.status === 'completed') {
    return { v: 2, status: gate.status, claimKey: body.claimKey };
  }
  if (gate.status === 'mismatched-token' || gate.status === 'expired' || gate.status === 'lost' ||
      gate.status === 'invalid' || gate.status === 'unavailable') {
    return { v: 2, status: gate.status };
  }
  return { v: 2, status: 'unavailable' };
}

/**
 * Execute one envelope body as a v2 claim operation. Returns undefined for any
 * other body kind so opaque v1 mail still appends unchanged. `opId` is the
 * envelope id (or a caller-chosen operation id) and only feeds lease source
 * ids; renew and release are addressed by claim key and fencing token.
 */
export function executeBusClaimBody(body: unknown, opId: string, options: BusClaimOptions = {}): BusClaimResult | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const kind = (body as { kind?: unknown }).kind;
  if (kind !== 'work.claim' && kind !== 'work.release') return undefined;
  const now = options.now ?? Date.now();
  if (kind === 'work.release') {
    const parsed = workReleaseBodySchema.safeParse(body);
    return parsed.success ? release(parsed.data, options, now) : { v: 2, status: 'invalid' };
  }
  const parsed = workClaimBodySchema.safeParse(body);
  if (!parsed.success) return { v: 2, status: 'invalid' };
  return parsed.data.op === 'acquire' ? acquire(parsed.data, opId, options, now) : renew(parsed.data, options, now);
}

/** HTTP status for each claim result; the conflict holder shape is the v2 contract. */
export const BUS_CLAIM_HTTP_STATUS: Record<BusClaimResult['status'], number> = {
  acquired: 201, renewed: 200, released: 200, completed: 200,
  conflict: 409, 'mismatched-token': 409, expired: 409, lost: 404,
  invalid: 400, unavailable: 503, full: 507,
};

/** CLI exit code: success 0, invalid arguments 2, every other refusal 1. */
export function busClaimExitCode(result: BusClaimResult): number {
  return result.status === 'acquired' || result.status === 'renewed' ||
    result.status === 'released' || result.status === 'completed' ? 0
    : result.status === 'invalid' ? 2 : 1;
}

/** Fresh operation id for CLI callers that do not pass --id. */
export function newBusClaimOpId(): string {
  return `busclaim-${randomUUID()}`;
}

/** How an `owner` filter resolved, so a label match is never mistaken for identity proof. */
export interface BusClaimsOwnerMatch {
  /** The routing ref exactly as passed. */
  ref: string;
  /** Stable id the ref resolved to; null means claims matched the exact owner label only. */
  identity: string | null;
  /** Registry state behind the resolution; 'unavailable' means same-identity labels may be missed. */
  registry: 'missing' | 'available' | 'unavailable';
}

/** An announced work-feed job a claim's keys overlap; the job's own status and title, never a guess. */
export interface BusClaimJobRef { id: string; owner: string; status: WorkJob['status']; title: string }

/** A live claim plus, when `jobs` was requested and the feed read ok, the jobs it blocks. */
export type BusClaimsListClaim = CoordinationView & { jobs?: BusClaimJobRef[] };

/** Feed read state behind a `jobs` request; a non-ok state means blocked jobs are unknown, not absent. */
export type BusClaimsFeedState = 'ok' | 'refused' | 'unavailable' | 'retryable' | 'invalid';

/**
 * Read-side companion to `executeBusClaimBody`: the live coordination claims
 * every bus participant shares, before it acquires or checks overlap. `source`
 * keeps the store state honest — `missing` is a verified-empty table,
 * `unavailable` means holds are unknown, not free. Expired rows are not holds.
 * Fencing tokens never leave the store. With `key`, the list narrows through
 * the same overlap rule an acquire applies, so it previews current blockers.
 * With `owner`, the list narrows to one holder: a ref that resolves through
 * the identity registry matches every label of that identity, while an
 * unresolvable ref or unreadable registry falls back to the exact owner label.
 * With `jobs`, each claim also names the announced feed jobs it blocks and
 * `feed` reports the read state; a non-ok feed leaves `jobs` absent.
 */
export type BusClaimsListResult =
  | { status: 'ok'; source: 'missing' | 'available'; claims: BusClaimsListClaim[]; asOf: string;
      owner?: BusClaimsOwnerMatch; feed?: BusClaimsFeedState }
  | { status: 'invalid' | 'unavailable'; asOf: string };

const OWNER_LABEL = /^[\x21-\x7e]{1,256}$/;

export function listBusClaims(options: BusClaimsListOptions = {}): BusClaimsListResult {
  const now = options.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const key = options.key;
  if (key !== undefined && parseClaimKey(key) === undefined) return { status: 'invalid', asOf };
  const owner = options.owner;
  if (owner !== undefined && !OWNER_LABEL.test(owner)) return { status: 'invalid', asOf };
  const listed = listCoordination(options.root, now);
  if (listed.source === 'unavailable') return { status: 'unavailable', asOf };
  let live = listed.claims.filter(row => row.live);
  let ownerMatch: BusClaimsOwnerMatch | undefined;
  if (owner !== undefined) {
    const read = readAgentRegistry({ root: options.root });
    const registry = read.status === 'ok' ? read.registry : undefined;
    const identity = registry === undefined ? undefined : resolveAgent(registry, owner)?.id;
    ownerMatch = { ref: owner, identity: identity ?? null,
      registry: read.status === 'ok' ? read.source : 'unavailable' };
    if (registry === undefined || identity === undefined) {
      live = live.filter(row => row.owner === owner);
    } else {
      const resolved = new Map<string, string | undefined>();
      const ownerId = (label: string): string | undefined => {
        if (!resolved.has(label)) resolved.set(label, resolveAgent(registry, label)?.id);
        return resolved.get(label);
      };
      live = live.filter(row => ownerId(row.owner) === identity);
    }
  }
  const claims = key === undefined ? live : live.filter(row => coordinationRowBlocks(row, key));
  let feed: BusClaimsFeedState | undefined;
  let annotated: BusClaimsListClaim[] = claims;
  if (options.jobs === true) {
    let result: ReturnType<typeof readBusWorkFeed>;
    try { result = readBusWorkFeed({ root: options.root, now: () => now }); }
    catch { result = { status: 'unavailable', asOf }; }
    feed = result.status;
    if (result.status === 'ok') {
      annotated = claims.map(row => ({
        ...row,
        jobs: result.jobs
          .filter(job => job.claimKeys.some(claimKey => coordinationRowBlocks(row, claimKey)))
          .map(job => ({ id: job.id, owner: job.owner, status: job.status, title: job.title })),
      }));
    }
  }
  return { status: 'ok', source: listed.source, claims: annotated, asOf,
    ...(ownerMatch === undefined ? {} : { owner: ownerMatch }),
    ...(feed === undefined ? {} : { feed }) };
}
