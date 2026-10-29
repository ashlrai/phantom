import type { JobClaim, LeaderLease, NodeSession, QueueV1 } from './queue-v1.js';
import { validId, type NodesState, type NodesStore } from './state.js';
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

  join(nodeId: string): NodeSession | null {
    if (!validId(nodeId)) throw new Error('Invalid drive node ID');
    return this.transaction((state, now) => {
      const existing = state.nodes.find(n => n.nodeId === nodeId);
      if (existing && existing.expiresAt > now) return null;
      const node = { nodeId, session: nextToken(state), heartbeatAt: now, expiresAt: now + this.nodeTtl };
      state.nodes = state.nodes.filter(n => n.nodeId !== nodeId);
      state.nodes.push(node);
      return { nodeId, session: node.session };
    });
  }

  /** Call each heartbeat interval. Renews this leader or automatically elects
   * this node after the old leader expires; a stale session must rejoin first.
   */
  heartbeat(session: NodeSession): { leader: LeaderLease | null } | null {
    return this.transaction((state, now) => {
      const node = state.nodes.find(n => sameSession(n, session));
      if (!node || node.expiresAt <= now) return null;
      // Check before extending node liveness, so expired authority never revives.
      const previous = this.liveLeader(state, now);
      node.heartbeatAt = now;
      node.expiresAt = now + this.nodeTtl;
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

  enqueue(jobId: string): boolean {
    if (!validId(jobId)) throw new Error('Invalid drive job ID');
    return this.transaction(state => {
      if (state.jobs.some(j => j.id === jobId)) return false;
      state.jobs.push({ id: jobId, state: 'pending' });
      return true;
    });
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
