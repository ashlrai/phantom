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
import { acquireCoordination, COORDINATION_ORIGINS, coordinationRowBlocks, listCoordination, renewCoordination, settleCoordination, type CoordinationOrigin, type CoordinationView } from './claim-store.js';
import { CLAIM_MAX_LEASE_MS, parseClaimKey, providerSchema, WORK_RESULT_OUTCOMES, WORK_TIERS,
  workClaimBodySchema, workReleaseBodySchema,
  type Participant, type WorkDispatch, type WorkJob, type WorkResultOutcome } from './bus-v2-schema.js';
import { agentChannelNameSchema, readAgentRegistry, resolveAgent, type AgentRegistry } from './bus-identity.js';
import { busReadContains, busReadContainsMatch } from './bus-unified.js';
import { BUS_FEED_OPEN_STATUSES, busWorkFeedOwnerMatcher, busWorkFeedPendingToMatcher, busWorkFeedRepoKey,
  BUS_WORK_FEED_CONTAINS_MAX, projectBusWorkFeedView, readBusWorkFeed,
  type BusWorkFeedJob, type BusWorkFeedReadResult } from './bus-work-feed-read.js';

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
   * When set, drop live claims owned by this routing ref — the same
   * identity-label resolution `owner` applies, inverted: a handle,
   * `agent:<handle>`, stable id or alias that resolves through the identity
   * registry excludes every label of that identity; an unresolvable ref or
   * unreadable registry excludes the exact owner label only. Composes with
   * `owner` — a holder both included and excluded lists nothing.
   */
  excludeOwner?: string;
  /**
   * When set, keep only live claims whose row text carries this needle — the
   * same `busReadContains`/`busReadContainsMatch` rule every bus read's
   * `--contains` applies, matched over the claim fields the list renders:
   * `key`, `sourceId` and the `repo`/`branch`/`path` target fields, so a
   * match is always visible in the row it selects.
   */
  contains?: string;
  /**
   * When set, keep only live claims whose recorded `started` — the lease's
   * ISO acquisition time, stable across renewals — is at or after this
   * epoch-ms cutoff: the same inclusive `>=` rule every bus read's `--since`
   * applies and the same field `work mine`'s claims section bounds. A claim
   * whose `started` is null or unparseable is unknown and never matches —
   * the same "unknown stays out" rule every other section's missing
   * timestamp follows.
   */
  since?: number;
  /**
   * When set, keep only live claims whose recorded `started` is strictly
   * before this epoch-ms cutoff — the exclusive upper bound composing with
   * `since` into one `[since, before)` window, the same rule every bus
   * read's `--before` applies. A null or unparseable `started` never
   * matches, and a claim still held but started inside the window stays
   * listed.
   */
  before?: number;
  /**
   * When set, only live claims of this origin class — `resource` for v2
   * work.claim leases, `message` for bus message-id claims, `team` for
   * team leases and `board` for board task claims. Queue path
   * observations are never live and never list. Anything outside
   * `COORDINATION_ORIGINS` answers `invalid`.
   */
  origin?: CoordinationOrigin;
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
 * id reused on a different key cannot silently relocate the first lease. The
 * store binds that row to the acquiring owner, so a different owner presenting
 * the same id conflicts with the live holder rather than replacing it.
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
export interface BusClaimJobRef { id: string; owner: string; status: WorkJob['status']; title: string;
  /** The feed job's newest status detail, when it carries one. */
  detail?: string;
  /** Wire id of the `work.post` receipt that announced the job — `agents bus show <postId>` reads it. */
  postId: string;
  /** Wire id of the newest accepted `work.status` receipt; null while no status has moved the job. */
  statusId: string | null }

/** A live claim plus, when `jobs` was requested and the feed read ok, the jobs it blocks. */
export type BusClaimsListClaim = CoordinationView & { jobs?: BusClaimJobRef[] };

/**
 * The claim-view projection of one announced feed job: id, announcer,
 * status, title and newest detail plus the retained `postId`/`statusId`
 * receipt citations — shared by `claim list --jobs` and `work mine`'s
 * claims section so both name the same `agents bus show` handles.
 */
export function busClaimJobRef(job: BusWorkFeedJob): BusClaimJobRef {
  return { id: job.id, owner: job.owner, status: job.status, title: job.title,
    ...(job.detail === undefined ? {} : { detail: job.detail }),
    postId: job.postId, statusId: job.statusId };
}

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
 * With `origin`, the list narrows to one claim class — the same rows the
 * claim's own `origin` field reports — so "which message-id claims do I
 * hold" is one filtered read instead of paging every team's leases and
 * board claims. With `excludeOwner`, the list drops one holder under the
 * same identity-label rule `owner` applies, inverted — "what do the other
 * seats hold" is one read. With `contains`, the list keeps claims whose
 * rendered fields carry the needle under the shared bus `--contains` rule.
 * With `since`/`before`, the list keeps claims whose recorded `started`
 * lands inside the `[since, before)` window — the same inclusive/exclusive
 * bounds every bus read's time filters apply, on the same field
 * `work mine`'s claims section already bounds — so "which claims started
 * lately" or "what was held before time T" is one filtered read of the
 * claim table itself. With `jobs`, each claim also names the announced feed jobs
 * it blocks and `feed` reports the read state; a non-ok feed leaves
 * `jobs` absent.
 */
export type BusClaimsListResult =
  | { status: 'ok'; source: 'missing' | 'available'; claims: BusClaimsListClaim[]; asOf: string;
      owner?: BusClaimsOwnerMatch; excludeOwner?: BusClaimsOwnerMatch; feed?: BusClaimsFeedState }
  | { status: 'invalid' | 'unavailable'; asOf: string };

const OWNER_LABEL = /^[\x21-\x7e]{1,256}$/;

/** The claim fields `contains` searches: the row's own rendered text, never a field the list hides. */
function busClaimRowContains(row: CoordinationView, needle: string): boolean {
  return busReadContainsMatch(row.key, needle) ||
    busReadContainsMatch(row.sourceId, needle) ||
    (row.repo !== null && busReadContainsMatch(row.repo, needle)) ||
    (row.branch !== null && busReadContainsMatch(row.branch, needle)) ||
    (row.path !== null && busReadContainsMatch(row.path, needle));
}

export function listBusClaims(options: BusClaimsListOptions = {}): BusClaimsListResult {
  const now = options.now ?? Date.now();
  const asOf = new Date(now).toISOString();
  const key = options.key;
  if (key !== undefined && parseClaimKey(key) === undefined) return { status: 'invalid', asOf };
  const owner = options.owner;
  if (owner !== undefined && !OWNER_LABEL.test(owner)) return { status: 'invalid', asOf };
  const excludeOwner = options.excludeOwner;
  if (excludeOwner !== undefined && !OWNER_LABEL.test(excludeOwner)) return { status: 'invalid', asOf };
  const containsNeedle = busReadContains(options.contains);
  if (containsNeedle === null) return { status: 'invalid', asOf };
  const origin = options.origin;
  if (origin !== undefined && !COORDINATION_ORIGINS.includes(origin)) return { status: 'invalid', asOf };
  const since = options.since;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) return { status: 'invalid', asOf };
  const before = options.before;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) return { status: 'invalid', asOf };
  const listed = listCoordination(options.root, now);
  if (listed.source === 'unavailable') return { status: 'unavailable', asOf };
  let live = listed.claims.filter(row => row.live);
  let ownerMatch: BusClaimsOwnerMatch | undefined;
  let excludeOwnerMatch: BusClaimsOwnerMatch | undefined;
  // One registry read serves both owner filters; each reports how its ref resolved.
  const registryRead = owner === undefined && excludeOwner === undefined ? undefined : readAgentRegistry({ root: options.root });
  const registry: AgentRegistry | undefined = registryRead?.status === 'ok' ? registryRead.registry : undefined;
  const registryState = registryRead === undefined ? 'missing' : registryRead.status === 'ok' ? registryRead.source : 'unavailable';
  const resolved = new Map<string, string | undefined>();
  const ownerId = (label: string): string | undefined => {
    if (!resolved.has(label)) resolved.set(label, registry === undefined ? undefined : resolveAgent(registry, label)?.id);
    return resolved.get(label);
  };
  // A ref that resolves through the registry matches every label of that
  // identity; an unresolvable ref or unreadable registry keeps exact-label
  // matching, so unknown identity state never widens or narrows a filter.
  const identityOf = (ref: string): string | undefined =>
    registry === undefined ? undefined : resolveAgent(registry, ref)?.id;
  if (owner !== undefined) {
    const identity = identityOf(owner);
    ownerMatch = { ref: owner, identity: identity ?? null, registry: registryState };
    live = live.filter(row => identity === undefined ? row.owner === owner : ownerId(row.owner) === identity);
  }
  if (excludeOwner !== undefined) {
    const identity = identityOf(excludeOwner);
    excludeOwnerMatch = { ref: excludeOwner, identity: identity ?? null, registry: registryState };
    live = live.filter(row => !(identity === undefined ? row.owner === excludeOwner : ownerId(row.owner) === identity));
  }
  if (origin !== undefined) live = live.filter(row => row.origin === origin);
  if (containsNeedle !== undefined) live = live.filter(row => busClaimRowContains(row, containsNeedle));
  if (since !== undefined || before !== undefined) {
    // A claim lists under a time window only when its recorded start lands
    // inside it — `started` is the lease's ISO acquisition time, and a null
    // or unparseable start is unknown, never a match: the same "unknown
    // stays out" rule work mine's claims section and every other section's
    // missing timestamp follow. A claim first taken before the window stays
    // live but is not new; a claim still held but started inside it lists.
    live = live.filter(row => {
      if (row.started === null) return false;
      const startedAt = Date.parse(row.started);
      if (!Number.isFinite(startedAt)) return false;
      return (since === undefined || startedAt >= since) && (before === undefined || startedAt < before);
    });
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
          .map(busClaimJobRef),
      }));
    }
  }
  return { status: 'ok', source: listed.source, claims: annotated, asOf,
    ...(ownerMatch === undefined ? {} : { owner: ownerMatch }),
    ...(excludeOwnerMatch === undefined ? {} : { excludeOwner: excludeOwnerMatch }),
    ...(feed === undefined ? {} : { feed }) };
}

// ─── Job-level claims ───────────────────────────────────────────────

/** The announced feed job a claim targets, echoed on every outcome that found it. */
export interface BusWorkJobClaimRef {
  id: string;
  owner: string;
  repo: string;
  title: string;
  status: WorkJob['status'];
  /** The feed job's newest status detail, when it carries one. */
  detail?: string;
  /** Wire id of the `work.post` receipt that announced the job — `agents bus show <postId>` reads it. */
  postId: string;
  /** Wire id of the newest accepted `work.status` receipt; null while no status has moved the job. */
  statusId: string | null;
}

export interface BusWorkJobClaimOptions extends BusClaimOptions {
  /** Work-feed job id to claim. */
  job: string;
  /** Lease owner routing label; claims coordinate, never authenticate. */
  owner: string;
  /** Lease length in milliseconds; the same 1..CLAIM_MAX_LEASE_MS bound as claim acquire. */
  leaseMs: number;
  /**
   * Declared claim key to take. The default prefers `queue:<jobId>` when the
   * job declares it, else the job's first declared key; an explicit key must
   * be one of the job's claimKeys — a key the announcement never declared is
   * refused rather than claimed outside the feed's view of the job.
   */
  key?: string;
  /** Operation id feeding the lease source id; default a fresh bus claim op id. */
  id?: string;
}

/** A live coordination hold blocking one of a job's declared claim keys other than the one a claim targeted. */
export interface BusWorkJobKeyHold {
  claimKey: string;
  owner: string;
  leaseUntil: number;
}

/**
 * The live holds across a claimed job's declared claim keys — the scope
 * conflicts a single-key acquire cannot see, so a worker learns at claim
 * time that a sibling `repo:`/`path:`/`pr:` scope is already held instead of
 * discovering it on a later feed or claim-list read. On `acquired`/`conflict`
 * the targeted key is excluded because its state is already reported by
 * `claim`/`holder`; on every other outcome that resolved the job no key's
 * state is separately reported, so `holds` covers every declared claim key —
 * the full hold map a claimant needs to see who already works (or is stuck
 * on) the job. `source` keeps the
 * coordination read honest: `unavailable` means holds are unknown, never an
 * empty free set; `missing` is a verified-empty table. Fencing tokens never
 * leave the store.
 */
export interface BusWorkJobClaimScope {
  source: 'missing' | 'available' | 'unavailable';
  holds: BusWorkJobKeyHold[];
}

export type BusWorkJobClaimResult =
  | { status: 'acquired'; job: BusWorkJobClaimRef; scope: BusWorkJobClaimScope;
      claim: { claimKey: string; owner: string; leaseMs: number; token: string; leaseUntil: number } }
  | { status: 'conflict'; job: BusWorkJobClaimRef; scope: BusWorkJobClaimScope;
      holder: { owner: string; claimKey: string; leaseUntil: number } }
  | { status: 'invalid' | 'refused' | 'unavailable' | 'retryable' | 'full'; reason: string;
      job?: BusWorkJobClaimRef; scope?: BusWorkJobClaimScope };

const JOB_LABEL = /^[\x21-\x7e]{1,128}$/;

function jobClaimRef(job: BusWorkFeedJob): BusWorkJobClaimRef {
  return { ...busClaimJobRef(job), repo: job.repo };
}

/**
 * Claim one declared key of an announced work-feed job in a single step — the
 * job-level companion to `claim acquire --key`. The live feed verifies the
 * job is shown and still open for a worker, the key resolves from the job's
 * own claimKeys (never reconstructed by the caller), and the lease lands in
 * the same coordination table through the same acquire path, so overlap with
 * every other claim origin still decides in one place. Claims coordinate
 * scope only; they grant no execution authority. A feed that cannot be read
 * refuses rather than claiming against a guessed job, and a non-open status,
 * empty or undeclared key set refuses before any lease is attempted. The
 * fencing token returns only inside the acquired claim, to its acquirer.
 * `acquired` and `conflict` also carry `scope`: the live holds on the job's
 * other declared claim keys, read through the same `coordinationRowBlocks`
 * overlap the feed's `--claims` join applies, so a sibling scope already held
 * by another participant is visible in the claim result itself. Every other
 * outcome that resolved the job carries `scope` too — over every declared
 * claim key, since no key's state is separately reported — so a
 * `job-not-open` or `undeclared-key` refusal already names who holds the
 * job's scopes instead of sending the claimant to a second claim-list read.
 */
export function claimBusWorkJob(options: BusWorkJobClaimOptions): BusWorkJobClaimResult {
  const now = options.now ?? Date.now();
  if (!JOB_LABEL.test(options.job)) return { status: 'invalid', reason: 'invalid-job' };
  if (!JOB_LABEL.test(options.owner)) return { status: 'invalid', reason: 'invalid-owner' };
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > CLAIM_MAX_LEASE_MS) {
    return { status: 'invalid', reason: 'invalid-lease' };
  }
  if (options.key !== undefined && parseClaimKey(options.key) === undefined) {
    return { status: 'invalid', reason: 'invalid-key' };
  }
  let feed: BusWorkFeedReadResult;
  try { feed = readBusWorkFeed({ root: options.root, now: () => now }); }
  catch { feed = { status: 'unavailable', asOf: new Date(now).toISOString() }; }
  if (feed.status !== 'ok') {
    return { status: feed.status, reason: `work-feed-${feed.status === 'refused' ? feed.reason : feed.status}` };
  }
  const job = feed.jobs.find(entry => entry.id === options.job);
  if (job === undefined) return { status: 'invalid', reason: 'unknown-job' };
  const ref = jobClaimRef(job);
  const listed = listCoordination(options.root, now);
  const holdsOn = (keys: string[]): BusWorkJobKeyHold[] =>
    listed.source === 'available'
      ? keys.flatMap(claimKey =>
          listed.claims.filter(row => coordinationRowBlocks(row, claimKey))
            .map(row => ({ claimKey, owner: row.owner, leaseUntil: row.leaseUntil })))
      : [];
  // Every outcome that is not acquired/conflict targeted no reported key, so
  // its scope covers all declared claim keys — the full hold map, queue key
  // included.
  const fullScope: BusWorkJobClaimScope = { source: listed.source, holds: holdsOn(job.claimKeys) };
  if (!BUS_FEED_OPEN_STATUSES.has(job.status)) return { status: 'refused', reason: 'job-not-open', job: ref, scope: fullScope };
  if (job.claimKeys.length === 0) return { status: 'refused', reason: 'no-claim-keys', job: ref, scope: fullScope };
  const queueKey = `queue:${job.id}`;
  const key = options.key ?? (job.claimKeys.includes(queueKey) ? queueKey : job.claimKeys[0]!);
  if (!job.claimKeys.includes(key)) return { status: 'refused', reason: 'undeclared-key', job: ref, scope: fullScope };
  const scope: BusWorkJobClaimScope = {
    source: listed.source,
    holds: holdsOn(job.claimKeys.filter(claimKey => claimKey !== key)),
  };
  const result = executeBusClaimBody(
    { kind: 'work.claim', op: 'acquire', jobId: job.id, claimKey: key, owner: options.owner, leaseMs: options.leaseMs },
    options.id ?? newBusClaimOpId(), { root: options.root, now });
  if (result === undefined) return { status: 'unavailable', reason: 'claim-unexpected', job: ref, scope: fullScope };
  if (result.status === 'acquired') return { status: 'acquired', job: ref, scope, claim: result.claim };
  if (result.status === 'conflict') return { status: 'conflict', job: ref, scope, holder: result.holder };
  if (result.status === 'invalid') return { status: 'invalid', reason: 'claim-invalid', job: ref, scope: fullScope };
  if (result.status === 'unavailable') return { status: 'unavailable', reason: 'claim-unavailable', job: ref, scope: fullScope };
  if (result.status === 'full') return { status: 'full', reason: 'claim-full', job: ref, scope: fullScope };
  return { status: 'unavailable', reason: 'claim-unexpected', job: ref, scope: fullScope };
}

// ─── Next-job claims ────────────────────────────────────────────────

/**
 * The `work feed` view filters `claimNextBusWorkJob` narrows its candidate
 * set with — every field the feed read serves except the implied
 * open-plus-claimable pair (a next-claim only ever considers provably
 * claimable open jobs) and `status`/`limit`, which a claim cannot use.
 * `repo` takes the same `owner/name` slug `busWorkFeedRepoKey` normalizes;
 * `to`/`announcer` are routing refs resolved through the same matchers the
 * feed's `--to`/`--owner` flags build; `id` is the retained-envelope
 * citation wire id `busWorkFeedJobCitesEnvelope` matches.
 * `excludeAnnouncer` is the one dim the feed view does not serve — the
 * feed read has no negative announcer filter — so it is applied to the
 * candidate set on the job's `owner` label directly, after the view.
 */
export interface BusWorkJobNextFilters {
  /** Keep only the job with this exact id — the feed `--job` filter. */
  jobId?: string;
  /** `owner/name` repo slug, normalized through `busWorkFeedRepoKey` like the feed `--repo`. */
  repo?: string;
  /** Keep only jobs announced for this provider — the feed `--provider` filter. */
  provider?: Participant['provider'];
  /** Keep only jobs whose announcement declared this dispatch tier — the feed `--tier` filter. */
  tier?: WorkDispatch['tier'];
  /**
   * Keep only jobs whose announcement `to` addresses this agent under the
   * pending-work rule — the literal label, every label of the identity it
   * resolves to, and `group:<channel>:<topic>` addresses of registry
   * channels it belongs to, minus the identity's own channel posts. This is
   * the `work next [<agent>]` positional's meaning on the feed side.
   */
  to?: string;
  /**
   * Keep only jobs announced by this routing ref — the feed `--owner`
   * filter under a name that cannot collide with the lease `owner`: a ref
   * resolving through the identity registry matches every label of that
   * identity, an unresolvable ref or unreadable registry keeps
   * exact-label matching.
   */
  announcer?: string;
  /**
   * Drop jobs announced by this routing ref — the negative counterpart of
   * `announcer`, resolved through the same `busWorkFeedOwnerMatcher`
   * identity-label rule the feed `--owner` filter and every bus read's
   * `--exclude-from` share, so "claim the next job X did not announce" is
   * one step instead of a filtered read followed by a manual skip. It
   * composes with `announcer`: a job whose owner both matches and is
   * excluded drops out, and an unresolvable ref or unreadable registry
   * keeps exact-label matching so unknown identity state never widens the
   * claim.
   */
  excludeAnnouncer?: string;
  /** Keep only jobs announced to `group:<channel>:*` — the feed `--channel` filter. */
  channel?: string;
  /** Keep only jobs announced to a `group:<room>:<topic>` address carrying this topic — the feed `--topic` filter. */
  topic?: string;
  /** Keep only jobs whose newest retained `work.result` citation carries this outcome — the feed `--result` filter. */
  result?: WorkResultOutcome;
  /**
   * Keep only jobs whose retained envelope citations include this wire id —
   * the feed `--id` filter. On `claim-next` this is the citation filter,
   * never a claim operation id: each call mints its own op id internally.
   */
  id?: string;
  /** Keep only jobs whose `updatedAt` is at or after this epoch-ms cutoff — the feed `--since` filter. */
  since?: number;
  /** Keep only jobs whose `updatedAt` is strictly before this epoch-ms cutoff — the feed `--before` filter. */
  before?: number;
  /** Keep only jobs whose descriptive text carries this needle — the feed `--contains` filter. */
  contains?: string;
}

export interface BusWorkJobNextOptions extends BusClaimOptions, BusWorkJobNextFilters {
  /** Lease owner routing label; claims coordinate, never authenticate. */
  owner: string;
  /** Lease length in milliseconds; the same 1..CLAIM_MAX_LEASE_MS bound as claim acquire. */
  leaseMs: number;
}

/**
 * The outcome of `claimNextBusWorkJob`. `acquired` is the `claimBusWorkJob`
 * acquired shape plus `attempted` — the number of key-level acquire calls
 * made across all candidates before the successful one. `empty` means no
 * candidate could be claimed this pass: `candidates` counts the filtered
 * open jobs with declared claim keys the claims-joined feed showed —
 * `held` counts the candidates whose declared keys are all held, either
 * proven by complete hold coverage at scan time or observed when every
 * tried key answered `conflict` — a live claim on that key, possibly the
 * requester's own — and `attempted` the total key attempts, so
 * `candidates - held` names candidates that failed for other reasons: a
 * job that went non-open or vanished mid-claim, or a store-level refusal.
 * All counts are observed over the filtered scan, never estimated. Every
 * other status is an honest failure: `invalid` rejects malformed arguments
 * before any read, and `refused`/`unavailable`/`retryable`/`full` pass
 * through the feed or coordination store's own state — a feed that cannot
 * be read never produces a guessed claim.
 */
export type BusWorkJobNextResult =
  | { status: 'acquired'; job: BusWorkJobClaimRef; scope: BusWorkJobClaimScope;
      claim: { claimKey: string; owner: string; leaseMs: number; token: string; leaseUntil: number };
      attempted: number }
  | { status: 'empty'; candidates: number; held: number; attempted: number }
  | { status: 'invalid' | 'refused' | 'unavailable' | 'retryable' | 'full'; reason: string; attempted: number };

/** The keys one candidate tries, `queue:<jobId>` first like `claimBusWorkJob`'s default: the provably-free set the claims join computed when it is non-empty, else every declared key — unknown coverage means a "held" key might still be free, so the attempt itself decides. */
function nextJobClaimKeys(job: BusWorkFeedJob): string[] {
  const keys = job.freeKeys !== null && job.freeKeys !== undefined && job.freeKeys.length > 0 ? job.freeKeys : job.claimKeys;
  const queueKey = `queue:${job.id}`;
  return keys.includes(queueKey) ? [queueKey, ...keys.filter(key => key !== queueKey)] : keys;
}

/**
 * Claim the next claimable work-feed job — the job-level companion
 * to `claimNextBusWork`, the same find-then-claim-in-one-step the v1
 * `work next` envelope claim provides. The candidate set is the
 * claims-joined feed view filtered by the `BusWorkJobNextFilters` dims,
 * narrowed to open jobs (`queued`/`rescheduled`) with declared claim keys —
 * the feed `--open` rule minus its complete-coverage exclusion, so a job
 * whose every key is provably held still counts as a held candidate rather
 * than vanishing from the scan. Candidates keep the feed view's
 * newest-first `updatedAt` order.
 *
 * Each candidate then runs the same `claimBusWorkJob` path — a fresh feed
 * and coordination read per attempt, so a job that moved between the scan
 * and its turn refuses rather than claiming stale state. A candidate whose
 * `claimable` is provably false counts as held with no attempt spent
 * re-learning what complete hold coverage already proved; otherwise its
 * keys are tried in `queue:<jobId>`-first order over the provably-free set
 * when the join computed one, else every declared key — a conflict on one
 * key still lets a sibling free key take the lease, and only a candidate
 * whose every tried key conflicts counts as `held`. `refused`/`invalid`
 * per-attempt outcomes (job-not-open, unknown-job, …) mark the candidate
 * stale and move to the next job; `unavailable`/`retryable`/`full` stop
 * the walk and return their own status. Claims coordinate scope only; they
 * grant no execution authority.
 */
export function claimNextBusWorkJob(options: BusWorkJobNextOptions): BusWorkJobNextResult {
  const invalid = (reason: string): BusWorkJobNextResult => ({ status: 'invalid', reason, attempted: 0 });
  if (!JOB_LABEL.test(options.owner)) return invalid('invalid-owner');
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1 || options.leaseMs > CLAIM_MAX_LEASE_MS) {
    return invalid('invalid-lease');
  }
  const repo = options.repo === undefined ? undefined : busWorkFeedRepoKey(options.repo);
  if (options.repo !== undefined && repo === undefined) return invalid('invalid-repo');
  if (options.provider !== undefined && !providerSchema.safeParse(options.provider).success) return invalid('invalid-provider');
  if (options.tier !== undefined && !(WORK_TIERS as readonly string[]).includes(options.tier)) return invalid('invalid-tier');
  if (options.result !== undefined && !(WORK_RESULT_OUTCOMES as readonly string[]).includes(options.result)) return invalid('invalid-result');
  for (const [flag, value] of [['job', options.jobId], ['to', options.to], ['announcer', options.announcer],
    ['excludeAnnouncer', options.excludeAnnouncer], ['id', options.id]] as const) {
    if (value !== undefined && !JOB_LABEL.test(value)) return invalid(`invalid-${flag}`);
  }
  if (options.channel !== undefined && !agentChannelNameSchema.safeParse(options.channel).success) return invalid('invalid-channel');
  if (options.topic !== undefined && !agentChannelNameSchema.safeParse(options.topic).success) return invalid('invalid-topic');
  if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0)) return invalid('invalid-since');
  if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 0)) return invalid('invalid-before');
  if (options.contains !== undefined &&
      (options.contains.trim() === '' || options.contains.length > BUS_WORK_FEED_CONTAINS_MAX)) {
    return invalid('invalid-contains');
  }
  const now = options.now ?? Date.now();
  let feed: BusWorkFeedReadResult;
  try { feed = readBusWorkFeed({ root: options.root, now: () => now, claims: true }); }
  catch { feed = { status: 'unavailable', asOf: new Date(now).toISOString() }; }
  if (feed.status !== 'ok') {
    return { status: feed.status, reason: `work-feed-${feed.status === 'refused' ? feed.reason : feed.status}`, attempted: 0 };
  }
  const view = projectBusWorkFeedView(feed, {
    jobId: options.jobId, repo, provider: options.provider, tier: options.tier,
    since: options.since, before: options.before, contains: options.contains,
    channel: options.channel, topic: options.topic, result: options.result, id: options.id,
    toMatch: options.to === undefined ? undefined : busWorkFeedPendingToMatcher(options.to, { root: options.root }),
    ownerMatch: options.announcer === undefined ? undefined : busWorkFeedOwnerMatcher(options.announcer, { root: options.root }),
  });
  if (view.status !== 'ok') return { status: 'unavailable', reason: 'work-feed-view', attempted: 0 };
  // `excludeAnnouncer` narrows the candidate set on the job's `owner` label
  // through the same identity matcher `announcer` uses — a claim can never
  // pick a job the matching read's exclusion would hide, and the observed
  // candidate/held counts below reflect the narrowed set.
  const excludeOwner = options.excludeAnnouncer === undefined ? undefined
    : busWorkFeedOwnerMatcher(options.excludeAnnouncer, { root: options.root });
  // The candidate set is every filtered open job with declared claim keys —
  // the feed `--open` rule minus its complete-coverage exclusion, so a job
  // whose every key is provably held still counts as a held candidate the
  // way `work next`'s drained `empty` reports held work rather than a dry
  // well. Non-open jobs and keyless jobs can never be claimed, so they are
  // not candidates at all.
  const candidates = view.jobs.filter(job => BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length > 0 &&
    (excludeOwner === undefined || !excludeOwner(job.owner)));
  const opId = newBusClaimOpId();
  let attempted = 0, held = 0;
  for (const job of candidates) {
    // Complete hold coverage already proved every declared key held: the
    // candidate counts as held with no attempt spent re-learning it.
    if (job.claimable === false) { held += 1; continue; }
    let conflicted = false, stale = false;
    for (const key of nextJobClaimKeys(job)) {
      attempted += 1;
      const result = claimBusWorkJob({ job: job.id, owner: options.owner, leaseMs: options.leaseMs,
        key, root: options.root, now, id: opId });
      if (result.status === 'acquired') {
        return { status: 'acquired', job: result.job, scope: result.scope, claim: result.claim, attempted };
      }
      if (result.status === 'conflict') { conflicted = true; continue; }
      if (result.status === 'unavailable' || result.status === 'retryable' || result.status === 'full') {
        return { status: result.status, reason: result.reason, attempted };
      }
      // refused/invalid: the job moved between the scan and this attempt —
      // unknown-job, job-not-open or a claim-layer refusal. Job-level stale:
      // its remaining keys cannot rescue it, so the walk moves on.
      stale = true;
      break;
    }
    if (conflicted && !stale) held += 1;
  }
  return { status: 'empty', candidates: candidates.length, held, attempted };
}
