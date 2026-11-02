import type { JobClaim, LeaderLease, NodeSession, QueueV1 } from './queue-v1.js';
import { planRoutes, routable, type RouteAssignment } from './router.js';
import { validCap, validId, validSecretName, type NodeAuth, type NodesState, type NodesStore } from './state.js';
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
}

/** Self-reported on each heartbeat. `auth` is the node's own local login status, never a token. */
export interface NodeReport {
  usage?: number;
  auth?: NodeAuth;
}

export interface JobSpec {
  owner: string;
  requires?: string[];
  pack?: string;
  secrets?: string[];
}

/** What a node may see of a job it is entitled to: references only, never values. */
export interface JobView {
  id: string;
  owner: string;
  state: 'pending' | 'running' | 'completed';
  requires: string[];
  pack?: string;
  secrets: string[];
}

export interface NodeView {
  nodeId: string;
  live: boolean;
  owners: string[];
  caps: string[];
  usage: number;
  auth: NodeAuth;
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
      return structuredClone(fn(state, now));
    });
  }

  private liveNode(state: NodesState, session: NodeSession, now: number): boolean {
    return state.nodes.some(n => sameSession(n, session) && n.expiresAt > now);
  }

  private liveLeader(state: NodesState, now: number): LeaderLease | null {
    const leader = state.leader;
    return leader && leader.expiresAt > now && this.liveNode(state, leader, now) ? leader : null;
  }

  join(nodeId: string, profile?: NodeProfile): NodeSession | null {
    if (!validId(nodeId)) throw new Error('Invalid drive node ID');
    const extra = profile && { owners: names(profile.owners, validId, 'owner scope'), caps: names(profile.caps, validCap, 'capability') };
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
    if (report?.usage !== undefined && !(Number.isSafeInteger(report.usage) && report.usage >= 0 && report.usage <= 1000)) {
      throw new Error('Invalid drive usage (integer permille 0-1000)');
    }
    return this.transaction((state, now) => {
      const node = state.nodes.find(n => sameSession(n, session));
      if (!node || node.expiresAt <= now) return null;
      // Check before extending node liveness, so expired authority never revives.
      const previous = this.liveLeader(state, now);
      node.heartbeatAt = now;
      node.expiresAt = now + this.nodeTtl;
      if (report?.usage !== undefined) node.usage = report.usage;
      if (report?.auth !== undefined) node.auth = report.auth;
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
    if (!validId(jobId)) throw new Error('Invalid drive job ID');
    if (spec && !validId(spec.owner)) throw new Error('Invalid drive owner scope');
    if (spec?.pack !== undefined && !validId(spec.pack)) throw new Error('Invalid drive pack reference');
    const extra = spec && {
      owner: spec.owner, requires: names(spec.requires, validCap, 'capability'),
      ...(spec.pack === undefined ? {} : { pack: spec.pack }),
      secrets: names(spec.secrets, validSecretName, 'secret name (use the NAME, never the value)'),
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
      let leader = this.liveLeader(state, now);
      if (!leader) {
        leader = state.leader = { ...worker, token: nextToken(state), expiresAt: now + this.leaderTtl };
      }
      const claim = { ...worker, jobId: job.id, token: nextToken(state), leaderToken: leader.token,
        expiresAt: now + this.claimTtl };
      job.state = 'running';
      job.claim = claim;
      return { claim, job: this.jobView(job) };
    });
  }

  private jobView(job: NonNullable<NodesState['jobs'][number]>): JobView {
    return { id: job.id, owner: job.owner!, state: job.state, requires: [...(job.requires ?? [])],
      ...(job.pack === undefined ? {} : { pack: job.pack }), secrets: [...(job.secrets ?? [])] };
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
          caps: n.caps ?? [], usage: n.usage ?? 0, auth: n.auth ?? 'unknown' }))
        .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
      jobs: state.jobs.filter(j => j.owner && scope.has(j.owner)).map(j => this.jobView(j)),
      routes: planRoutes(state, now).filter(a => scope.has(a.owner)),
    }));
  }

  private currentClaim(state: NodesState, claim: JobClaim, now: number): boolean {
    const stored = state.jobs.find(j => j.id === claim.jobId && j.state === 'running')?.claim;
    const leader = this.liveLeader(state, now);
    return !!stored && !!leader && stored.token === claim.token && sameSession(stored, claim) &&
      stored.leaderToken === claim.leaderToken && stored.leaderToken === leader.token &&
      stored.expiresAt > now && this.liveNode(state, stored, now);
  }

  claim(leader: LeaderLease, worker: NodeSession, jobId: string): JobClaim | null {
    return this.transaction((state, now) => {
      const current = this.liveLeader(state, now);
      if (!current || current.token !== leader.token || !sameSession(current, leader) ||
          !this.liveNode(state, worker, now)) return null;
      const job = state.jobs.find(j => j.id === jobId);
      if (!job || job.state === 'completed' || (job.claim && this.currentClaim(state, job.claim, now))) return null;
      const claim = { ...worker, jobId, token: nextToken(state), leaderToken: current.token,
        expiresAt: now + this.claimTtl };
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

  complete(claim: JobClaim, result: string): boolean {
    if (typeof result !== 'string' || Buffer.byteLength(result) > 64 * 1024) throw new Error('Invalid drive job result');
    return this.transaction((state, now) => {
      if (!this.currentClaim(state, claim, now)) return false;
      const job = state.jobs.find(j => j.id === claim.jobId)!;
      job.state = 'completed';
      job.result = result;
      return true;
    });
  }
}
