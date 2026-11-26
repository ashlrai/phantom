import type { EmbeddedNodeTask } from './task.js';
/** Provisional queue.v1 contract until RQ-PHANTOM-DRIVER-1-QUEUE lands.
 * Queue state and lease state MUST commit in the same transaction. A remote
 * adapter must perform compare-and-set at the authority, never read then write.
 */
export interface QueueJobV1 {
  task?: EmbeddedNodeTask;
  id: string;
  state: 'pending' | 'running' | 'completed';
  /** Owner scope: only nodes that belong to it may see, route or pull the job. */
  owner?: string;
  /** Capabilities a node must advertise (`gh` additionally needs a live local auth heartbeat). */
  requires?: string[];
  /** Context-pack reference. An ID only, never pack contents. */
  pack?: string;
  /** Secret NAMES the executor resolves from its own local custody, never values. */
  secrets?: string[];
  claim?: JobClaim;
  /** Node sessions that released this job unrun (it cannot execute it). A session never re-pulls or
   * re-claims it; a rejoined node has a new session and tries again. Bounded to the newest 16. */
  declined?: number[];
  result?: string;
  producerWithdrawn?: true;
  /** Witness-clock execution boundaries; retries replace startedAt. */
  startedAt?: number;
  executionHostId?: string;
  completedAt?: number;
}

export interface NodeSession {
  nodeId: string;
  session: number;
}

export interface LeaderLease extends NodeSession {
  token: number;
  expiresAt: number;
}

export interface JobClaim extends NodeSession {
  jobId: string;
  token: number;
  leaderToken: number;
  expiresAt: number;
}

export interface QueueV1 {
  readonly version: 'queue.v1';
  enqueue(jobId: string): boolean;
  /** Assign `jobId` to `worker` under the live leader lease. Refuses (null) when the worker fails
   * the job's execution fences — its session declined the job, its caps miss `requires`, or `gh`
   * work lacks a live local auth heartbeat — the same fences pull routing applies.
   * A running job is eligible only once its claim expires, even after a leader change. */
  claim(leader: LeaderLease, worker: NodeSession, jobId: string): JobClaim | null;
  renewClaim(claim: JobClaim): JobClaim | null;
  complete(claim: JobClaim, result: string): boolean;
  /** Hand a held claim back unrun; the job returns to pending without penalty. `decline` also records
   * that this session can never run it (permanent), so it is not routed there again. Default: retryable. */
  release(claim: JobClaim, decline?: boolean): boolean;
}
