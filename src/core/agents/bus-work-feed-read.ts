/** Read the bounded local work feed. Labels grant no execution authority. */
import { BUS_INBOX_MAX_MESSAGES, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { coordinationRowBlocks, listCoordination, type CoordinationOrigin } from './claim-store.js';
import { projectBusWorkFeed, type WorkFeedOwnerKeyFor, type WorkFeedProviderFor, type WorkFeedRefusalReceipt,
  type WorkFeedResult, type WorkFeedResultCitation } from './bus-work-feed.js';
import { agentAddressMatcher, agentIdentityKeys, readAgentRegistry, resolveAgent, type AgentIdentity } from './bus-identity.js';
import { scrubSecrets } from '../util/scrub.js';
import { repoSlugSchema } from './bus-v2-schema.js';
import type { Participant, WorkDispatch, WorkJob } from './bus-v2-schema.js';

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

/** A feed job plus the wire ids of the retained envelopes its state cites. */
export interface BusWorkFeedJob extends WorkJob {
  /** Wire id of the `work.post` receipt that announced the job — `agents bus show <postId>` reads it. */
  postId: string;
  /** Wire id of the newest accepted `work.status` receipt; null while no status has moved the job. */
  statusId: string | null;
  /** Newest `work.result` receipt citing the job — the outcome a worker/peer
   * reported (receipt id, reporter label, outcome, optional reason, receipt
   * time). Evidence only: it never moved the job's status. */
  result?: WorkFeedResultCitation;
  /** Present only on open-status jobs (`BUS_FEED_OPEN_STATUSES`) when the read joined claims: declared claim keys with no shown live hold — null unless hold coverage is complete. */
  freeKeys?: string[] | null;
  /** Present only on open-status jobs when the read joined claims: declared claim keys with at least one shown live hold — null when the hold set itself is unknown. */
  heldKeys?: string[] | null;
  /** Present only on open-status jobs when the read joined claims: true — a declared key is provably free; false — every declared key is provably held; null — coverage cannot prove either way. */
  claimable?: boolean | null;
}

/** How completely the coordination holds behind a feed read are known. */
export type BusWorkFeedHoldCoverage = 'complete' | 'truncated' | 'unknown';

/** The per-key hold coverage one job's declared claim keys carry — the same tri-state `work mine` reports. */
export interface BusWorkFeedJobHold {
  /** Declared keys with no shown live hold — null unless hold coverage is complete. */
  freeKeys: string[] | null;
  /** Declared keys with at least one shown live hold — null when the hold set itself is unknown. */
  heldKeys: string[] | null;
  /** true: a declared key is provably free; false: every declared key is provably held; null: coverage incomplete. */
  claimable: boolean | null;
}

/**
 * The hold-coverage rule every "is this job claimable" surface shares:
 * `complete` means every live hold is shown, so an unheld declared key is
 * provably free; `truncated` means shown holds are real but later ones are
 * not, so a key with no shown hold might still be held; `unknown` means the
 * hold set could not be read at all. `claimable` is true only on a provably
 * free key, false only when every declared key is provably held.
 */
export function busWorkFeedJobHold(
  job: BusWorkFeedJob, held: ReadonlySet<string> | undefined, coverage: BusWorkFeedHoldCoverage,
): BusWorkFeedJobHold {
  const heldKeys = coverage === 'unknown' ? null : job.claimKeys.filter(key => held?.has(key));
  const freeKeys = coverage === 'complete' ? job.claimKeys.filter(key => !held?.has(key)) : null;
  const claimable = coverage === 'unknown' ? null
    : coverage === 'complete' ? job.claimKeys.some(key => !held?.has(key))
    : heldKeys !== null && heldKeys.length === job.claimKeys.length ? false : null;
  return { freeKeys, heldKeys, claimable };
}

/**
 * The hold evidence behind one claims join, shared by the feed annotation
 * and the `work mine` digest: the coverage state plus the shown holds grouped
 * by job id. `unknown` means the coordination table could not be read;
 * `truncated` means shown holds are real but later ones are unseen.
 */
export function busWorkFeedHoldIndex(claims: BusWorkFeedClaims | undefined): {
  coverage: BusWorkFeedHoldCoverage;
  heldByJob: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const coverage: BusWorkFeedHoldCoverage =
    claims === undefined || claims.source === 'unavailable' ? 'unknown'
    : claims.truncated ? 'truncated' : 'complete';
  const heldByJob = new Map<string, Set<string>>();
  for (const hold of claims?.holds ?? []) {
    const set = heldByJob.get(hold.jobId) ?? new Set<string>();
    set.add(hold.claimKey);
    heldByJob.set(hold.jobId, set);
  }
  return { coverage, heldByJob };
}

export type BusWorkFeedReadResult =
  | { status: 'ok'; jobs: BusWorkFeedJob[]; receipts: number; asOf: string; claims?: BusWorkFeedClaims }
  | { status: 'refused'; reason: Extract<WorkFeedResult, { status: 'refused' }>['reason']; receipts: number; asOf: string;
      /** The retained receipt the projection blamed, when it named one. */
      receipt?: WorkFeedRefusalReceipt }
  | { status: 'unavailable' | 'retryable' | 'invalid'; asOf: string };

const HOLDS_MAX = 1024;

/** Feed statuses that still mean "open for a worker": queued or rescheduled. Progress reports and terminal states are not claimable. */
export const BUS_FEED_OPEN_STATUSES: ReadonlySet<WorkJob['status']> = new Set(['queued', 'rescheduled']);

/** Longest `--contains` needle the work-feed view accepts; the job text it matches is already bounded far shorter. */
export const BUS_WORK_FEED_CONTAINS_MAX = 512;

/** Largest `limit` page the feed surfaces accept — the same item bound `fleet_comms_inbox` applies. */
export const BUS_WORK_FEED_LIMIT_MAX = 200;

/**
 * The ok feed view after a `limit` page: `matched` counts every job the
 * filters kept before the slice and `omitted` the jobs beyond the shown
 * page — the same honest-truncation pair the other bounded fleet reads
 * report. `jobs` stays newest-first (the view already sorts), and claims
 * holds regroup under the shown jobs only, so a hold never names a hidden
 * job. Non-ok results pass through untouched: a refused or unavailable feed
 * fabricates no page and no counts. `limit` must be an integer in
 * 1..BUS_WORK_FEED_LIMIT_MAX; every caller validates before slicing.
 */
export type BusWorkFeedPaged = Extract<BusWorkFeedReadResult, { status: 'ok' }> & {
  /** Jobs the filters kept before the page slice. */
  matched: number;
  /** Matched jobs beyond the shown page. */
  omitted: number;
};

export function sliceBusWorkFeedView(result: BusWorkFeedReadResult, limit: number): BusWorkFeedReadResult | BusWorkFeedPaged {
  if (result.status !== 'ok') return result;
  const matched = result.jobs.length;
  const jobs = result.jobs.slice(0, limit);
  const shown = new Set(jobs.map(job => job.id));
  const view: BusWorkFeedPaged = { ...result, jobs, matched, omitted: matched - jobs.length };
  if (result.claims !== undefined) {
    view.claims = { ...result.claims, holds: result.claims.holds.filter(hold => shown.has(hold.jobId)) };
  }
  return view;
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
  const ok: BusWorkFeedReadResult = { status: 'ok',
    jobs: result.feed.jobs.map(job => {
      // The projection records a citation for every job it emits.
      const citation = result.citations.get(job.id)!;
      return { ...job, postId: citation.post, statusId: citation.status,
        ...(citation.result === undefined ? {} : { result: citation.result }) };
    }),
    receipts: receipts.length, asOf };
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
  const claims: BusWorkFeedClaims = { source: listed.source, holds, truncated };
  // Open jobs carry the same per-key hold coverage `work mine` reports, so a
  // feed read answers "which of these can I claim" without a second join;
  // non-open jobs keep only the raw holds — claimable has no meaning there.
  const { coverage, heldByJob } = busWorkFeedHoldIndex(claims);
  return { ...ok, jobs: ok.jobs.map(job => BUS_FEED_OPEN_STATUSES.has(job.status)
      ? { ...job, ...busWorkFeedJobHold(job, heldByJob.get(job.id), coverage) } : job),
    claims };
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

/**
 * Normalize a `--repo` feed filter to the lowercase `owner/name` key claim
 * keys compare under — the same repo-slug shape `work.post`/`workJob` enforce;
 * undefined when the value is not a repo slug, so a bad filter is a usage
 * error rather than a silent empty view.
 */
export function busWorkFeedRepoKey(repo: string): string | undefined {
  return repoSlugSchema.safeParse(repo).success ? repo.toLowerCase() : undefined;
}

/** Client-side feed filters shared by the feed CLIs; every field narrows, none fabricates. */
export interface BusWorkFeedViewFilters {
  /** Keep only jobs in this feed status. */
  status?: WorkJob['status'];
  /** Keep only the job with this exact id. */
  jobId?: string;
  /** Keep only jobs announced for this repo — the lowercase owner/name key `busWorkFeedRepoKey` returns. */
  repo?: string;
  /** Keep only jobs announced for this provider. */
  provider?: Participant['provider'];
  /** Keep only jobs whose announcement declared this dispatch tier; a job with no dispatch spec declares none and never matches. */
  tier?: WorkDispatch['tier'];
  /** Keep only open jobs whose declared claim keys provably include a free key; needs the claims join to mean anything. */
  claimable?: true;
  /** Open-status candidates with declared keys; incomplete hold coverage keeps candidates visible. */
  open?: true;
  /**
   * Keep only jobs whose last activity is at or after this epoch-ms cutoff —
   * `job.updatedAt`, the receipt time of the newest accepted `work.status`,
   * or the `work.post` receipt time while no status has moved the job. The
   * same inclusive `>=` rule every `--since` bus read applies.
   */
  since?: number;
  /** Announcement-address predicate from `busWorkFeedToMatcher`. */
  toMatch?: (to: string) => boolean;
  /** Announcer predicate over `job.owner` from `busWorkFeedOwnerMatcher`. */
  ownerMatch?: (owner: string) => boolean;
  /**
   * Keep only jobs whose descriptive text carries the needle as a
   * case-insensitive substring — the announcement title, the newest status
   * detail and the declared dispatch scope/acceptance, each scrubbed,
   * single-lined and clipped at the same bounds `formatBusWorkFeedJob`
   * renders, with whitespace collapsed on both sides: the same `--contains`
   * rule every other bus read applies, so "which announced jobs mention X"
   * is one filtered read and a secret-shaped value stays unfindable. Ids,
   * claim keys, statuses and routing labels are structured fields with
   * their own filters, never search text.
   */
  contains?: string;
}

/**
 * Client-side `--status`/`--job`/`--repo`/`--provider`/`--tier`/`--claimable`/`--since`/
 * `--to`/`--owner`/`--contains` filters and newest-first ordering shared by
 * the feed CLIs;
 * the matchers are the `busWorkFeedToMatcher`/`busWorkFeedOwnerMatcher`
 * predicates. `since` keeps jobs whose `updatedAt` — the newest status
 * receipt time, or the announcement's while no status has moved the job —
 * reaches the cutoff, so "which jobs moved lately" is one filtered read
 * instead of paging terminal jobs that have sat unchanged.
 * With claims, holds regroup under the jobs still shown so a filtered view
 * never lists a hold for a hidden job. `--claimable` keeps only jobs whose
 * tri-state `claimable` is provably true — unknown coverage never counts as
 * claimable, and a read without the claims join has no field to match, so it
 * answers an honest empty view. `--open` keeps queued/rescheduled candidates
 * with declared keys; only complete holds can exclude a fully held job.
 * Non-ok results pass through untouched;
 * nothing is fabricated for a refused or unavailable read.
 */
export function projectBusWorkFeedView(result: BusWorkFeedReadResult, filters: BusWorkFeedViewFilters = {}): BusWorkFeedReadResult {
  if (result.status !== 'ok') return result;
  const { coverage, heldByJob } = busWorkFeedHoldIndex(result.claims);
  // The needle normalizes once — lowercase, whitespace collapsed, trimmed —
  // so a phrase typed with stray spacing still finds its job; a blank
  // needle is the empty substring and narrows nothing.
  const containsNeedle = filters.contains === undefined ? undefined
    : filters.contains.toLowerCase().replace(/\s+/g, ' ').trim();
  const jobs = result.jobs
    .filter(job => (filters.status === undefined || job.status === filters.status)
      && (filters.jobId === undefined || job.id === filters.jobId)
      && (filters.repo === undefined || job.repo.toLowerCase() === filters.repo)
      && (filters.provider === undefined || job.provider === filters.provider)
      && (filters.tier === undefined || job.dispatch?.tier === filters.tier)
      && (filters.claimable !== true || job.claimable === true)
      && (filters.open !== true || (BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length > 0
        && (coverage !== 'complete' || job.claimKeys.some(key => !heldByJob.get(job.id)?.has(key)))))
      && (filters.since === undefined || job.updatedAt >= filters.since)
      && (filters.toMatch === undefined || filters.toMatch(job.to))
      && (filters.ownerMatch === undefined || filters.ownerMatch(job.owner))
      && (containsNeedle === undefined || busWorkFeedJobSearchText(job).includes(containsNeedle)))
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
const DISPATCH_SCOPE_MAX = 200;
const DISPATCH_ACCEPTANCE_MAX = 160;

/** Scrubbed, single-line, clipped display field; '' when nothing readable remains. */
function feedField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The descriptive text a feed job's `--contains` filter searches: the
 * announcement title, the newest status detail and the declared dispatch
 * scope/acceptance — each through the same `feedField` scrub, single-line
 * and display clip the job line renders, joined and normalized like every
 * other `--contains` haystack. A match is therefore always visible in the
 * row it selects, and a secret-shaped value is scrubbed before the match
 * even though the stored envelope keeps it.
 */
export function busWorkFeedJobSearchText(job: BusWorkFeedJob): string {
  return [
    feedField(job.title, FEED_TITLE_MAX),
    job.detail === undefined ? '' : feedField(job.detail, FEED_DETAIL_MAX),
    job.dispatch === undefined ? '' : feedField(job.dispatch.scope, DISPATCH_SCOPE_MAX),
    job.dispatch === undefined ? '' : feedField(job.dispatch.acceptance, DISPATCH_ACCEPTANCE_MAX),
  ].join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The `dispatch` spec a `work.post` declared, rendered for the job line as
 * ` tier=<t> scope="<clipped>" acceptance="<clipped>"` — the tier verbatim,
 * scope and acceptance scrubbed, single-lined and display-clipped like every
 * other feed field (JSON keeps the full values; `agents bus show <postId>`
 * reads the untruncated body). '' when the job carries no dispatch, so
 * callers append the result unconditionally.
 */
export function busWorkJobDispatch(dispatch: WorkDispatch | undefined): string {
  if (dispatch === undefined) return '';
  const scope = feedField(dispatch.scope, DISPATCH_SCOPE_MAX);
  const acceptance = feedField(dispatch.acceptance, DISPATCH_ACCEPTANCE_MAX);
  return ` tier=${dispatch.tier}` +
    `${scope === '' ? '' : ` scope="${scope}"`}` +
    `${acceptance === '' ? '' : ` acceptance="${acceptance}"`}`;
}

/**
 * ` result=<outcome> [reason=<r>] by=<from> at=<iso> receipt=<id>` — the
 * newest `work.result` evidence a feed job carries, display-clipped like
 * every other feed field; '' when no result is retained. Shared by the feed
 * job line and `work mine`'s jobs/announced lines so every surface renders
 * the report identically. An out-of-range receipt time stays `unknown`,
 * never an invalid timestamp.
 */
export function busWorkJobResultSuffix(job: Pick<BusWorkFeedJob, 'result'>): string {
  const result = job.result;
  if (result === undefined) return '';
  const reason = result.reason === undefined ? '' : ` reason=${feedField(result.reason, 64)}`;
  const from = feedField(result.from, 96);
  const at = Number.isSafeInteger(result.receivedAt) && Math.abs(result.receivedAt) <= 8_640_000_000_000_000
    ? new Date(result.receivedAt).toISOString() : 'unknown';
  return ` result=${result.outcome}${reason} by=${from === '' ? '-' : from} at=${at} receipt=${result.id}`;
}

/** One human line for a single feed job: the announcement's own title, the
 * newest status's detail when it carries one, the declared dispatch spec when
 * the post carried one, claim keys — display-clipped
 * (JSON keeps the full values) — the newest `work.result` report when one is
 * retained, and the wire ids of the retained envelopes the job cites. Shared
 * by the feed list and `agents bus show`'s job annotation so both render a
 * job identically. */
export function formatBusWorkFeedJob(job: BusWorkFeedJob): string {
  const title = feedField(job.title, FEED_TITLE_MAX);
  const detail = job.detail === undefined ? '' : feedField(job.detail, FEED_DETAIL_MAX);
  const keys = job.claimKeys.length === 0 ? 'none' : feedField(job.claimKeys.join(','), FEED_KEYS_MAX);
  const claimable = job.claimable === undefined ? ''
    : ` claimable=${job.claimable === null ? 'unknown' : job.claimable ? 'yes' : 'no'}`;
  return `${job.id} ${job.status}${title === '' ? '' : ` "${title}"`}` +
    `${detail === '' ? '' : ` detail="${detail}"`}` +
    ` owner=${job.owner} to=${job.to} provider=${job.provider} repo=${job.repo}${busWorkJobDispatch(job.dispatch)} keys=${keys}${claimable} ` +
    `updated=${new Date(job.updatedAt).toISOString()} post=${job.postId}` +
    `${job.statusId === null ? '' : ` status=${job.statusId}`}${busWorkJobResultSuffix(job)}`;
}

/** Human-readable feed lines shared by `fleet work-feed` and `agents bus work feed`. */
export function formatBusWorkFeed(result: BusWorkFeedReadResult | BusWorkFeedPaged): string[] {
  const lines: string[] = [];
  if (result.status === 'ok') {
    for (const job of result.jobs) {
      lines.push(formatBusWorkFeedJob(job));
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
  const receiptNote = result.status === 'refused' && result.receipt !== undefined ? ` receipt=${result.receipt.id}` : '';
  const pageNote = result.status === 'ok' && 'matched' in result ? ` matched=${result.matched} omitted=${result.omitted}` : '';
  lines.push(`jobs=${result.status === 'ok' ? result.jobs.length : 'unknown'} receipts=${'receipts' in result ? result.receipts : 'unknown'} feed=${feed}${receiptNote} as-of=${result.asOf}${claimsNote}${pageNote}`);
  return lines;
}
