/** Provisional queue.v1 contract until RQ-PHANTOM-DRIVER-1-QUEUE lands.
 * Queue state and lease state MUST commit in the same transaction. A remote
 * adapter must perform compare-and-set at the authority, never read then write.
 */
export interface QueueJobV1 {
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
  result?: string;
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
  claim(leader: LeaderLease, worker: NodeSession, jobId: string): JobClaim | null;
  renewClaim(claim: JobClaim): JobClaim | null;
  complete(claim: JobClaim, result: string): boolean;
}
