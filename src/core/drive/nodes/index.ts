import type { JobClaim, LeaderLease, NodeSession, QueueV1 } from './queue-v1.js';
import { validNodeTask, type EmbeddedNodeTask } from './task.js';
import { actionableClaim, jobBlockers, nodeCapacityView, nodeCanAcceptWork, planRoutes, routable, type RouteAssignment } from './router.js';
import { liveLeader, validCap, validId, validSecretName, type NodeAuth, type NodesState, type NodesStore } from './state.js';
import { isLocalModelCap } from '../../local-runtime/omlx/models.js';
import { isNodeCapacity, isHostStats, type NodeCapacitySample, type HostStats } from './state.js';
export { planRoutes } from './router.js';
export type { RouteAssignment } from './router.js';
export { LocalNodesStore } from './local-store.js';
export type { JobClaim, LeaderLease, NodeSession, QueueV1 } from './queue-v1.js';
export type { NodeRecord, NodesState, NodesStore } from './state.js';

export interface NodesOptions {
  nodeTtlMs?: number;
  leaderTtlMs?: number;
  claimTtlMs?: number;
  /** Authority clock, injectable for tests. Production uses one host clock. */
  now?: () => number;
}

/** What a node advertises when it joins. `owners` is its only visibility scope. */
export interface NodeProfile {
  owners: string[];
  caps?: string[];
  /** Zero holds admission; omitted retains legacy unbounded routing. */
  slots?: number;
}

/** Self-reported on each heartbeat. `auth` is the node's own local login status, never a token. */
export interface NodeReport {
  capacity?: NodeCapacitySample;
  hostStats?: HostStats;
  usage?: number;
  slots?: number;
  auth?: NodeAuth;
}

export interface JobSpec {
  task?: EmbeddedNodeTask;
  owner: string;
  requires?: string[];
  pack?: string;
  secrets?: string[];
}

/** What a node may see of a job it is entitled to: references only, never values.
 * Embedded task text is included only in the successful pull response. */
export interface JobView {
  task?: EmbeddedNodeTask;
  id: string;
  owner: string;
  state: 'pending' | 'running' | 'completed';
  requires: string[];
  pack?: string;
  secrets: string[];
  producerWithdrawn?: true;
  /** Accepted completion's executor identity; no result body or fencing token. */
  completedBy?: string;
  /** Status views only: the node whose live session can still act on a running claim. Never sent to a runner. */
  claimedBy?: string;
}

/** Withdrawal result text; producerWithdrawn distinguishes it from a node result. */
export const WITHDRAWN_RESULT = 'withdrawn';
/** `withdrawn`: fenced terminal now (or earlier), safe to run elsewhere. `held`: a live claim still owns it. */
export interface WithdrawOutcome {
  state: 'withdrawn' | 'held' | 'completed' | 'absent';
  /** Accepted node result reference, only for `completed`. */
  result?: string;
}

/** Read-only per-job outcome inside one owner scope. `absent` covers both an
 * unknown id and a job owned by another scope, so the read never leaks across
 * owners. Fencing tokens and the claim record never leave the store. */
export interface JobOutcome {
  state: 'pending' | 'running' | 'completed' | 'absent';
  /** Accepted completion text; present only when `state` is `completed`. */
  result?: string;
  /** Executor node id of an accepted completion (the withdrawal marker's id
   * when `producerWithdrawn` is set). */
  completedBy?: string;
  /** Witness-clock completion time of an accepted completion. */
  completedAt?: number;
  /** Node whose live session can still act on a running claim. */
  claimedBy?: string;
  producerWithdrawn?: true;
}

export interface NodeView {
  capacity?: NodeCapacitySample;
  nodeId: string;
  live: boolean;
  owners: string[];
  caps: string[];
  /** Self-reported permille load; null until a heartbeat reports one — never a fabricated 0. */
  usage: number | null;
  slots?: number;
  auth: NodeAuth;
  heartbeatAt: number;
  expiresAt: number;
  lanes: string[];
}

export interface Pulled {
  claim: JobClaim;
  job: JobView;
}

function names(values: string[] | undefined, ok: (v: unknown) => boolean, what: string): string[] {
  const out = [...new Set(values ?? [])].sort();
  if (out.length > 64 || !out.every(ok)) throw new Error(`Invalid drive ${what}`);
  return out;
}

function validSlots(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 64; }

function sameSession(a: NodeSession, b: NodeSession): boolean {
  return a.nodeId === b.nodeId && a.session === b.session;
}

function nextToken(state: NodesState): number {
  if (state.sequence === Number.MAX_SAFE_INTEGER) throw new Error('Drive fencing counter exhausted');
  return ++state.sequence;
}

/** Registry, election and queue completion share one serialization boundary. */
export class DriveNodes implements QueueV1 {
  readonly version = 'queue.v1' as const;
  private readonly nodeTtl: number;
  private readonly leaderTtl: number;
  private readonly claimTtl: number;
  private readonly clock: () => number;

  constructor(private readonly store: NodesStore, options: NodesOptions = {}) {
    this.nodeTtl = options.nodeTtlMs ?? 30_000;
    this.leaderTtl = options.leaderTtlMs ?? 10_000;
    this.claimTtl = options.claimTtlMs ?? 30_000;
    this.clock = options.now ?? Date.now;
    for (const ttl of [this.nodeTtl, this.leaderTtl, this.claimTtl]) {
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('Invalid drive lease duration');
    }
  }

  private transaction<T>(fn: (state: NodesState, now: number) => T): T {
    return this.store.transaction(state => {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < state.observedAt ||
          !Number.isSafeInteger(now + Math.max(this.nodeTtl, this.leaderTtl, this.claimTtl))) {
        throw new Error('Invalid or regressed drive authority clock');
      }
      state.observedAt = now;
      // Legacy producer fences predate producerWithdrawn. Result text alone is
      // also a valid worker result, so require the complete withdrawal signature.
      for (const job of state.jobs) {
        const claim = job.claim;
        if (job.producerWithdrawn === undefined && job.state === 'completed' && job.result === WITHDRAWN_RESULT &&
            claim?.nodeId === WITHDRAWN_RESULT && claim.jobId === job.id &&
            Number.isSafeInteger(claim.token) && claim.token > 0 && claim.token <= state.sequence &&
            claim.session === claim.token && claim.leaderToken === claim.token &&
            job.completedAt !== undefined && Number.isSafeInteger(job.completedAt) && job.completedAt >= 0 &&
            claim.expiresAt === job.completedAt && job.completedAt <= now) {
          job.producerWithdrawn = true;
        }
      }
      return structuredClone(fn(state, now));
    });
  }

  private liveNode(state: NodesState, session: NodeSession, now: number): boolean {
    return state.nodes.some(n => sameSession(n, session) && n.expiresAt > now);
  }

  join(nodeId: string, profile?: NodeProfile): NodeSession | null {
    if (!validId(nodeId)) throw new Error('Invalid drive node ID');
    if (profile?.slots !== undefined && !validSlots(profile.slots)) throw new Error('Invalid drive slots (integer 0-64)');
    const extra = profile && { owners: names(profile.owners, validId, 'owner scope'), caps: names(profile.caps, validCap, 'capability'),
      ...(profile.slots === undefined ? {} : { slots: profile.slots }) };
    if (extra && extra.owners.length === 0) throw new Error('Invalid drive owner scope');
    return this.transaction((state, now) => {
      const existing = state.nodes.find(n => n.nodeId === nodeId);
      if (existing && existing.expiresAt > now) return null;
      const node: NodesState['nodes'][number] = { nodeId, session: nextToken(state), heartbeatAt: now,
        expiresAt: now + this.nodeTtl, ...extra };
      state.nodes = state.nodes.filter(n => n.nodeId !== nodeId);
      state.nodes.push(node);
      return { nodeId, session: node.session };
    });
  }

  /** Call each heartbeat interval. Renews this leader or automatically elects
   * this node after the old leader expires; a stale session must rejoin first.
   */
  heartbeat(session: NodeSession, report?: NodeReport): { leader: LeaderLease | null } | null {
    if (report?.capacity !== undefined && !isNodeCapacity(report.capacity)) throw new Error('Invalid node capacity sample');
    if (report?.hostStats !== undefined && !isHostStats(report.hostStats)) throw new Error('Invalid host stats');
    if (report?.usage !== undefined && !(Number.isSafeInteger(report.usage) && report.usage >= 0 && report.usage <= 1000)) {
      throw new Error('Invalid drive usage (integer permille 0-1000)');
    }
    if (report?.slots !== undefined && !validSlots(report.slots)) throw new Error('Invalid drive slots (integer 0-64)');
    return this.transaction((state, now) => {
      const node = state.nodes.find(n => sameSession(n, session));
      if (!node || node.expiresAt <= now) return null;
      // Check before extending node liveness, so expired authority never revives.
      const previous = liveLeader(state, now);
      node.heartbeatAt = now;
      node.expiresAt = now + this.nodeTtl;
      if (report?.usage !== undefined) node.usage = report.usage;
      if (report?.slots !== undefined) node.slots = report.slots;
      if (report?.capacity !== undefined) { node.capacity = structuredClone(report.capacity); node.slots = report.capacity.slots; }
      if (report?.auth !== undefined) node.auth = report.auth;
      if (report?.hostStats !== undefined) node.hostStats = structuredClone(report.hostStats);
      if (!previous) {
        state.leader = { ...session, token: nextToken(state), expiresAt: now + this.leaderTtl };
      } else if (sameSession(previous, session)) {
        previous.expiresAt = now + this.leaderTtl;
      }
      return { leader: state.leader };
    });
  }

  leave(session: NodeSession): boolean {
    return this.transaction(state => {
      const index = state.nodes.findIndex(n => sameSession(n, session));
      if (index < 0) return false;
      state.nodes.splice(index, 1);
      if (state.leader && sameSession(state.leader, session)) state.leader = null;
      return true;
    });
  }

  snapshot(): NodesState {
    return this.transaction(state => state);
  }

  enqueue(jobId: string, spec?: JobSpec): boolean {
    if (spec?.task !== undefined && (spec.pack !== 'codex-file' || !validNodeTask(spec.task))) throw new Error('Invalid embedded node task');
    if (!validId(jobId)) throw new Error('Invalid drive job ID');
    if (spec && !validId(spec.owner)) throw new Error('Invalid drive owner scope');
    if (spec?.pack !== undefined && !validId(spec.pack)) throw new Error('Invalid drive pack reference');
    const extra = spec && {
      owner: spec.owner, requires: names(spec.requires, validCap, 'capability'),
      ...(spec.pack === undefined ? {} : { pack: spec.pack }),
      secrets: names(spec.secrets, validSecretName, 'secret name (use the NAME, never the value)'),
      ...(spec.task === undefined ? {} : { task: structuredClone(spec.task) }),
    };
    return this.transaction(state => {
      if (state.jobs.some(j => j.id === jobId)) return false;
      state.jobs.push({ id: jobId, state: 'pending', ...extra });
      return true;
    });
  }

  /** Deterministic routing preview over live nodes; pass `owner` to scope it. */
  plan(owner?: string): RouteAssignment[] {
    return this.transaction((state, now) => planRoutes(state, now, owner));
  }

  /** Pull-based dispatch. The node takes the next job the router assigned to it, inside one
   * transaction, so two nodes racing for a job get one claim and one null. A node never
   * matches a job outside its owner scopes. Uses the live leader's epoch (electing this
   * node when none is live), so a failover fences every older pull.
   */
  pull(worker: NodeSession): Pulled | null {
    return this.transaction((state, now) => {
      const node = state.nodes.find(n => sameSession(n, worker) && n.expiresAt > now);
      if (!node) return null;
      const mine = planRoutes(state, now).find(a => a.nodeId === node.nodeId);
      const job = mine && state.jobs.find(j => j.id === mine.jobId);
      if (!job || !routable(job, now)) return null;
      let leader = liveLeader(state, now);
      if (!leader) {
        leader = state.leader = { ...worker, token: nextToken(state), expiresAt: now + this.leaderTtl };
      }
      const claim = { ...worker, jobId: job.id, token: nextToken(state), leaderToken: leader.token,
        expiresAt: now + this.claimTtl };
      job.executionHostId = node.capacity?.hostId;
      job.startedAt = now; delete job.completedAt;
      job.state = 'running';
      job.claim = claim;
      return { claim, job: { ...this.jobView(job), ...(job.task === undefined ? {} : { task: job.task }) } };
    });
  }

  /** Whether this exact session can still act right now. `pull` answers null for a
   * dead session and for an empty route alike; a caller that must tell them apart
   * asks here. */
  sessionLive(session: NodeSession): boolean {
    return this.transaction((state, now) => this.liveNode(state, session, now));
  }

  /** The last advertised join profile for a node id, live or expired; null when the
   * id never joined or its record was removed by leave. Read-only: session and
   * fencing tokens never leave the store through it. */
  nodeProfile(nodeId: string): NodeProfile | null {
    if (!validId(nodeId)) return null;
    return this.transaction(state => {
      const node = state.nodes.find(n => n.nodeId === nodeId);
      if (!node) return null;
      return { owners: [...(node.owners ?? [])], caps: [...(node.caps ?? [])],
        ...(node.slots === undefined ? {} : { slots: node.slots }) };
    });
  }

  private jobView(job: NonNullable<NodesState['jobs'][number]>): JobView {
    return { id: job.id, owner: job.owner!, state: job.state, requires: [...(job.requires ?? [])],
      ...(job.pack === undefined ? {} : { pack: job.pack }), secrets: [...(job.secrets ?? [])],
      ...(job.producerWithdrawn ? { producerWithdrawn: true as const } : {}),
      ...(job.state === 'completed' && job.claim ? { completedBy: job.claim.nodeId } : {}) };
  }

  /** The only read surface for a node or its operator: everything is filtered to the caller's
   * owner scopes, so jobs, packs, secret names and peer nodes of another owner never appear.
   * Session and fencing tokens are not exposed.
   */
  view(owners: string[]): { owners: string[]; nodes: NodeView[]; jobs: JobView[]; routes: RouteAssignment[] } {
    const scope = new Set(names(owners, validId, 'owner scope'));
    return this.transaction((state, now) => ({
      owners: [...scope],
      nodes: state.nodes.filter(n => n.owners?.some(o => scope.has(o)))
        .map(n => ({ nodeId: n.nodeId, live: n.expiresAt > now, owners: (n.owners ?? []).filter(o => scope.has(o)),
          caps: n.caps ?? [], lanes: (n.caps ?? []).filter(c => ['codex', 'claude'].includes(c) || isLocalModelCap(c)),
          heartbeatAt: n.heartbeatAt, expiresAt: n.expiresAt, usage: n.usage ?? null, auth: n.auth ?? 'unknown',
          ...(n.capacity ? { capacity: n.capacity } : {}),
          ...(n.slots === undefined ? {} : { slots: n.slots }) }))
        .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
      jobs: state.jobs.filter(j => j.owner && scope.has(j.owner)).map(j => ({ ...this.jobView(j),
        ...(actionableClaim(state, j, now) ? { claimedBy: j.claim!.nodeId } : {}) })),
      routes: planRoutes(state, now).filter(a => scope.has(a.owner)),
    }));
  }

  private currentClaim(state: NodesState, claim: JobClaim, now: number): boolean {
    const stored = state.jobs.find(j => j.id === claim.jobId && j.state === 'running')?.claim;
    const leader = liveLeader(state, now);
    return !!stored && !!leader && stored.token === claim.token && sameSession(stored, claim) &&
      stored.leaderToken === claim.leaderToken && stored.leaderToken === leader.token &&
      stored.expiresAt > now && this.liveNode(state, stored, now);
  }

  /** Leader-side assignment under the live lease. Applies the same execution
   * fences as `pull` — a declined session, missing caps or absent `gh` auth is
   * refused — so a claim can never hand a job to a node routing would reject.
   * Owner scope stays the leader's deliberate choice. */
  claim(leader: LeaderLease, worker: NodeSession, jobId: string): JobClaim | null {
    return this.transaction((state, now) => {
      const current = liveLeader(state, now);
      if (!current || current.token !== leader.token || !sameSession(current, leader) ||
          !this.liveNode(state, worker, now)) return null;
      const node = state.nodes.find(n => sameSession(n, worker))!;
      if (!nodeCanAcceptWork(node, now)) return null;
      const active = state.jobs.filter(j => j.claim?.nodeId === worker.nodeId && actionableClaim(state, j, now)).length;
      if (node.slots !== undefined && active >= node.slots) return null;
      if (state.pool && !nodeCapacityView(state, now).some(h => h.eligibleNodeIds.includes(node.nodeId) && (h.freeSlots ?? 0) > 0)) return null;
      const job = state.jobs.find(j => j.id === jobId);
      if (!job || job.state === 'completed' || (job.claim && this.currentClaim(state, job.claim, now))) return null;
      if (jobBlockers(node, job).length > 0) return null;
      const claim = { ...worker, jobId, token: nextToken(state), leaderToken: current.token,
        expiresAt: now + this.claimTtl };
      job.executionHostId = node.capacity?.hostId;
      job.startedAt = now; delete job.completedAt;
      job.state = 'running';
      job.claim = claim;
      return claim;
    });
  }

  renewClaim(claim: JobClaim): JobClaim | null {
    return this.transaction((state, now) => {
      if (!this.currentClaim(state, claim, now)) return null;
      const stored = state.jobs.find(j => j.id === claim.jobId)!.claim!;
      stored.expiresAt = now + this.claimTtl;
      return stored;
    });
  }

  /** Return a held claim unrun: the job is pending again, the old token is dead (renew and complete
   * both refuse it) and the releasing session is not routed this job again only when `decline` is set (a permanent
   * inability). A transient refusal (capacity, stop) leaves the job retryable by this session. Same fencing
   * check as `complete`, so a stale or replaced holder cannot release a newer holder's claim.
   */
  release(claim: JobClaim, decline = false): boolean {
    return this.transaction((state, now) => {
      if (!this.currentClaim(state, claim, now)) return false;
      const job = state.jobs.find(j => j.id === claim.jobId)!;
      job.state = 'pending';
      delete job.claim;
      if (decline) job.declined = [...(job.declined ?? []).filter(s => s !== claim.session), claim.session].slice(-16);
      return true;
    });
  }

  complete(claim: JobClaim, result: string): boolean {
    if (typeof result !== 'string' || Buffer.byteLength(result) > 64 * 1024) throw new Error('Invalid drive job result');
    return this.transaction((state, now) => {
      if (!this.currentClaim(state, claim, now)) return false;
      const job = state.jobs.find(j => j.id === claim.jobId)!;
      job.completedAt = now;
      job.state = 'completed';
      job.result = result;
      return true;
    });
  }

  /** Producer-side fence for a job in `owner`'s scope. A pending job, or one whose claim
   * lapsed, becomes terminal under a fresh fencing token, so neither a later pull nor the
   * old holder's renew/complete can succeed. A live claim is left alone (`held`). Idempotent.
   */
  withdraw(jobId: string, owner: string): WithdrawOutcome {
    if (!validId(jobId) || !validId(owner)) throw new Error('Invalid drive job ID');
    return this.transaction((state, now) => {
      const job = state.jobs.find(j => j.id === jobId && j.owner === owner);
      if (!job) return { state: 'absent' as const };
      if (job.state === 'completed') {
        return job.producerWithdrawn === true
          ? { state: 'withdrawn' as const } : { state: 'completed' as const, result: job.result ?? '' };
      }
      const stored = job.claim;
      const leader = liveLeader(state, now);
      if (job.state === 'running' && stored && stored.expiresAt > now && this.liveNode(state, stored, now) &&
          !!leader && stored.leaderToken === leader.token) return { state: 'held' as const };
      const token = nextToken(state);
      job.claim = { nodeId: WITHDRAWN_RESULT, session: token, jobId, token, leaderToken: token, expiresAt: now };
      job.state = 'completed';
      job.completedAt = now;
      job.result = WITHDRAWN_RESULT;
      job.producerWithdrawn = true;
      return { state: 'withdrawn' as const };
    });
  }

  /** Read-only counterpart of `withdraw` for the job's owner: the accepted
   * result text once completed, the live claim's node while running, or the
   * bare state otherwise. Same owner match as `withdraw`, so a job in another
   * scope answers `absent`. Never mutates state and never exposes tokens. */
  jobOutcome(jobId: string, owner: string): JobOutcome {
    if (!validId(jobId) || !validId(owner)) throw new Error('Invalid drive job ID');
    return this.transaction((state, now) => {
      const job = state.jobs.find(j => j.id === jobId && j.owner === owner);
      if (!job) return { state: 'absent' };
      if (job.state === 'completed') {
        return { state: 'completed', result: job.result ?? '',
          ...(job.claim ? { completedBy: job.claim.nodeId } : {}),
          ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
          ...(job.producerWithdrawn ? { producerWithdrawn: true as const } : {}) };
      }
      if (job.state === 'running') {
        return { state: 'running', ...(actionableClaim(state, job, now) ? { claimedBy: job.claim!.nodeId } : {}) };
      }
      return { state: 'pending' };
    });
  }
}
