/** Read the bounded local work feed. Labels grant no execution authority. */
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { coordinationRowBlocks, listCoordination, type CoordinationOrigin } from './claim-store.js';
import { projectBusWorkFeed, type WorkFeedOwnerKeyFor, type WorkFeedProviderFor, type WorkFeedResult } from './bus-work-feed.js';
import { readAgentRegistry, resolveAgent, type AgentIdentity } from './bus-identity.js';
import type { Participant, WorkJob } from './bus-v2-schema.js';

/** One live coordination lease blocking a job's declared claim key. */
export interface BusWorkFeedHold {
  jobId: string;
  claimKey: string;
  owner: string;
  leaseUntil: number;
  origin: CoordinationOrigin | 'queue';
  sourceId: string;
}

export interface BusWorkFeedClaims {
  /** missing: verified empty table; unavailable: holds are unknown, not free. */
  source: 'missing' | 'available' | 'unavailable';
  holds: BusWorkFeedHold[];
  /** True when the hold list hit its bound; later holds are not shown. */
  truncated: boolean;
}

export interface BusWorkFeedReadOptions {
  root?: string;
  now?: () => number;
  claims?: boolean;
  /** Explicit participant metadata; consulted before the provider fallback. */
  participants?: readonly Participant[];
  /** Provider fallback for sender labels; defaults to the identity registry's newest runtime. */
  providerFor?: WorkFeedProviderFor;
  /** Owner-key fallback for sender labels; defaults to the identity registry's stable id. */
  ownerKeyFor?: WorkFeedOwnerKeyFor;
}

export type BusWorkFeedReadResult =
  | { status: 'ok'; jobs: WorkJob[]; receipts: number; asOf: string; claims?: BusWorkFeedClaims }
  | { status: 'refused'; reason: Extract<WorkFeedResult, { status: 'refused' }>['reason']; receipts: number; asOf: string }
  | { status: 'unavailable' | 'retryable' | 'invalid'; asOf: string };

const HOLDS_MAX = 1024;

/** Provider of the identity's most recently seen runtime; undefined when it has none. */
export function runtimeProvider(identity: AgentIdentity): Participant['provider'] | undefined {
  let provider: Participant['provider'] | undefined;
  let seen = -1;
  for (const runtime of identity.runtimes) {
    if (runtime.lastSeenAt > seen) { seen = runtime.lastSeenAt; provider = runtime.provider; }
  }
  return provider;
}

interface RegistryHints {
  providerFor: WorkFeedProviderFor;
  ownerKeyFor: WorkFeedOwnerKeyFor;
}

/**
 * Sender-label hints from the identity registry beside the bus store: a label
 * that resolves to a registered identity takes that identity's newest runtime
 * provider and its stable id as the owner key, so one agent's handle, address
 * and aliases count as the same job owner. An absent or unreadable registry
 * hints nothing, so provider stays unknown and owner matching stays strict —
 * the projection still refuses rather than guessing.
 */
function registryHints(root: string | undefined): RegistryHints | undefined {
  const read = readAgentRegistry({ root });
  if (read.status !== 'ok') return undefined;
  const registry = read.registry;
  const providers = new Map<string, Participant['provider'] | undefined>();
  const owners = new Map<string, string | undefined>();
  return {
    providerFor: (from) => {
      if (!providers.has(from)) {
        const identity = resolveAgent(registry, from);
        providers.set(from, identity ? runtimeProvider(identity) : undefined);
      }
      return providers.get(from);
    },
    ownerKeyFor: (from) => {
      if (!owners.has(from)) {
        const identity = resolveAgent(registry, from);
        owners.set(from, identity?.id);
      }
      return owners.get(from);
    },
  };
}

/** No writes, network, claims or dispatch. Freeze the clock across pages. */
export function readBusWorkFeed(options: BusWorkFeedReadOptions = {}): BusWorkFeedReadResult {
  const now = (options.now ?? Date.now)();
  const asOf = new Date(now).toISOString();
  const receipts: BusInboxReceipt[] = [];
  let cursor = 0;
  while (receipts.length < BUS_INBOX_MAX_MESSAGES) {
    const page = listBusInboxAfter(cursor, 100, { root: options.root, now: () => now, includeOriginalEnvelope: true });
    if (page.status !== 'ok') {
      // full/conflict belong to append; conservatively treat them as unavailable.
      const status = page.status === 'invalid' || page.status === 'retryable' ? page.status : 'unavailable';
      return { status, asOf };
    }
    receipts.push(...page.messages.slice(0, BUS_INBOX_MAX_MESSAGES - receipts.length).map(receipt => ({
      cursor: receipt.cursor, receivedAt: receipt.receivedAt,
      envelope: receipt.originalEnvelope ?? receipt.envelope,
    })));
    if (page.messages.length < 100 || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  const hints = registryHints(options.root);
  const result = projectBusWorkFeed(receipts, options.participants ?? [],
    options.providerFor ?? hints?.providerFor, options.ownerKeyFor ?? hints?.ownerKeyFor);
  if (result.status !== 'ok') return { ...result, receipts: receipts.length, asOf };
  const ok: BusWorkFeedReadResult = { status: 'ok', jobs: result.feed.jobs, receipts: receipts.length, asOf };
  if (!options.claims) return ok;
  const listed = listCoordination(options.root, now);
  const holds: BusWorkFeedHold[] = [];
  let truncated = false;
  if (listed.source === 'available') {
    outer: for (const job of result.feed.jobs) {
      for (const claimKey of job.claimKeys) {
        for (const row of listed.claims) {
          if (!coordinationRowBlocks(row, claimKey)) continue;
          if (holds.length >= HOLDS_MAX) { truncated = true; break outer; }
          holds.push({ jobId: job.id, claimKey, owner: row.owner, leaseUntil: row.leaseUntil,
            origin: row.origin, sourceId: row.sourceId });
        }
      }
    }
  }
  return { ...ok, claims: { source: listed.source, holds, truncated } };
}
