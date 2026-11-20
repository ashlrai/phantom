/** Read the bounded local work feed. Labels grant no execution authority. */
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { coordinationRowBlocks, listCoordination, type CoordinationOrigin } from './claim-store.js';
import { projectBusWorkFeed, type WorkFeedOwnerKeyFor, type WorkFeedProviderFor, type WorkFeedResult } from './bus-work-feed.js';
import { agentAddressMatcher, agentIdentityKeys, readAgentRegistry, resolveAgent, type AgentIdentity } from './bus-identity.js';
import { scrubSecrets } from '../util/scrub.js';
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

/** Feed statuses that still mean "open for a worker": queued or rescheduled. Progress reports and terminal states are not claimable. */
export const BUS_FEED_OPEN_STATUSES: ReadonlySet<WorkJob['status']> = new Set(['queued', 'rescheduled']);

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
 * Match a routing label against a ref under every label of one agent identity —
 * the same contract `bus next`, `bus-follow`, handoff receive and claim
 * `--owner` use: the literal label always matches, and any label resolving to
 * the ref's identity key matches too. A ref that resolves to no identity, and
 * an unreadable registry, keep exact-label matching, so unknown identity state
 * never widens the filter.
 */
function feedLabelMatcher(ref: string, options: { root?: string }): (label: string) => boolean {
  return agentAddressMatcher(agentIdentityKeys({ root: options.root }), ref);
}

/** Announcement-address matcher for a job's `to` label. */
export function busWorkFeedToMatcher(to: string, options: { root?: string } = {}): (label: string) => boolean {
  return feedLabelMatcher(to, options);
}

/** Announcer matcher for a job's `owner` label — the same identity contract `to` uses. */
export function busWorkFeedOwnerMatcher(owner: string, options: { root?: string } = {}): (label: string) => boolean {
  return feedLabelMatcher(owner, options);
}

/** Client-side feed filters shared by the feed CLIs; every field narrows, none fabricates. */
export interface BusWorkFeedViewFilters {
  /** Keep only jobs in this feed status. */
  status?: WorkJob['status'];
  /** Keep only the job with this exact id. */
  jobId?: string;
  /** Announcement-address predicate from `busWorkFeedToMatcher`. */
  toMatch?: (to: string) => boolean;
  /** Announcer predicate over `job.owner` from `busWorkFeedOwnerMatcher`. */
  ownerMatch?: (owner: string) => boolean;
}

/**
 * Client-side `--status`/`--job`/`--to`/`--owner` filters and newest-first
 * ordering shared by the feed CLIs; the matchers are the
 * `busWorkFeedToMatcher`/`busWorkFeedOwnerMatcher` predicates. With claims,
 * holds regroup under the jobs still shown so a filtered view never lists a
 * hold for a hidden job. Non-ok results pass through untouched; nothing is
 * fabricated for a refused or unavailable read.
 */
export function projectBusWorkFeedView(result: BusWorkFeedReadResult, filters: BusWorkFeedViewFilters = {}): BusWorkFeedReadResult {
  if (result.status !== 'ok') return result;
  const jobs = result.jobs
    .filter(job => (filters.status === undefined || job.status === filters.status)
      && (filters.jobId === undefined || job.id === filters.jobId)
      && (filters.toMatch === undefined || filters.toMatch(job.to))
      && (filters.ownerMatch === undefined || filters.ownerMatch(job.owner)))
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

const FEED_TITLE_MAX = 160;
const FEED_DETAIL_MAX = 200;
const FEED_KEYS_MAX = 480;

/** Scrubbed, single-line, clipped display field; '' when nothing readable remains. */
function feedField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One human line per job: the announcement's own title, the newest status's
 * detail when it carries one, and claim keys — display-clipped (JSON keeps
 * the full values). */
function feedJobLine(job: WorkJob): string {
  const title = feedField(job.title, FEED_TITLE_MAX);
  const detail = job.detail === undefined ? '' : feedField(job.detail, FEED_DETAIL_MAX);
  const keys = job.claimKeys.length === 0 ? 'none' : feedField(job.claimKeys.join(','), FEED_KEYS_MAX);
  return `${job.id} ${job.status}${title === '' ? '' : ` "${title}"`}` +
    `${detail === '' ? '' : ` detail="${detail}"`}` +
    ` owner=${job.owner} to=${job.to} provider=${job.provider} repo=${job.repo} keys=${keys} ` +
    `updated=${new Date(job.updatedAt).toISOString()}`;
}

/** Human-readable feed lines shared by `fleet work-feed` and `agents bus work feed`. */
export function formatBusWorkFeed(result: BusWorkFeedReadResult): string[] {
  const lines: string[] = [];
  if (result.status === 'ok') {
    for (const job of result.jobs) {
      lines.push(feedJobLine(job));
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
