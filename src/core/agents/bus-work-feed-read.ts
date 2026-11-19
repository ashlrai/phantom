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

/** Statuses that still mean "open for a worker"; running/idle/blocked are progress reports, the rest are terminal. */
export const BUS_FEED_OPEN_STATUSES: ReadonlySet<WorkJob['status']> = new Set(['queued', 'rescheduled']);

/**
 * True when the claims join can prove which keys are held: a verified-empty
 * (`missing`) or fully listed (`available`, untruncated) table. An unavailable
 * or truncated table leaves holds unknown — open jobs stay candidates, never
 * proven closed or proven free.
 */
export function busFeedHoldsKnown(claims: BusWorkFeedClaims | undefined): boolean {
  return claims !== undefined && claims.source !== 'unavailable' && !claims.truncated;
}

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

/**
 * Client-side `--status` filter, `--open` worker-availability filter and
 * newest-first ordering shared by the feed CLIs. With claims, holds regroup
 * under the jobs still shown so a filtered view never lists a hold for a
 * hidden job. `open` keeps only jobs still open for a worker — a queued or
 * rescheduled status, at least one declared claim key, and (when hold state
 * is known) at least one key no live lease blocks; unknown holds keep
 * candidates rather than proving them closed. Non-ok results pass through
 * untouched; nothing is fabricated for a refused or unavailable read.
 */
export function projectBusWorkFeedView(result: BusWorkFeedReadResult, status?: WorkJob['status'], open = false): BusWorkFeedReadResult {
  if (result.status !== 'ok') return result;
  const claims = result.claims;
  const holdsKnown = open && busFeedHoldsKnown(claims);
  const heldByJob = new Map<string, Set<string>>();
  if (holdsKnown && claims !== undefined) {
    for (const hold of claims.holds) {
      const set = heldByJob.get(hold.jobId) ?? new Set<string>();
      set.add(hold.claimKey);
      heldByJob.set(hold.jobId, set);
    }
  }
  const jobs = result.jobs
    .filter(job => status === undefined || job.status === status)
    .filter(job => {
      if (!open) return true;
      if (!BUS_FEED_OPEN_STATUSES.has(job.status) || job.claimKeys.length === 0) return false;
      if (!holdsKnown) return true;
      const held = heldByJob.get(job.id);
      return job.claimKeys.some(key => !held?.has(key));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const view: Extract<BusWorkFeedReadResult, { status: 'ok' }> = { ...result, jobs };
  if (result.claims !== undefined) {
    const byJob = new Map<string, BusWorkFeedHold[]>();
    for (const hold of result.claims.holds) {
      const list = byJob.get(hold.jobId) ?? [];
      list.push(hold);
      byJob.set(hold.jobId, list);
    }
    view.claims = { ...result.claims, holds: jobs.flatMap(job => byJob.get(job.id) ?? []) };
  }
  return view;
}

/** Human-readable feed lines shared by `fleet work-feed` and `agents bus work feed`. */
export function formatBusWorkFeed(result: BusWorkFeedReadResult): string[] {
  const lines: string[] = [];
  if (result.status === 'ok') {
    for (const job of result.jobs) {
      lines.push(`${job.id} ${job.status} owner=${job.owner} provider=${job.provider} repo=${job.repo} updated=${new Date(job.updatedAt).toISOString()}`);
    }
    if (result.claims) {
      for (const hold of result.claims.holds) {
        lines.push(`held ${hold.jobId} ${hold.claimKey} owner=${hold.owner} until=${new Date(hold.leaseUntil).toISOString()}`);
      }
    }
  }
  const feed = result.status === 'refused' ? `refused:${result.reason}` : result.status;
  const claimsNote = result.status === 'ok' && result.claims
    ? ` claims=${result.claims.source}${result.claims.truncated ? ':truncated' : ''}` : '';
  lines.push(`jobs=${result.status === 'ok' ? result.jobs.length : 'unknown'} receipts=${'receipts' in result ? result.receipts : 'unknown'} feed=${feed} as-of=${result.asOf}${claimsNote}`);
  return lines;
}
