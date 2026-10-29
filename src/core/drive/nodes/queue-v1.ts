/** Provisional queue.v1 contract until RQ-PHANTOM-DRIVER-1-QUEUE lands.
 * Queue state and lease state MUST commit in the same transaction. A remote
 * adapter must perform compare-and-set at the authority, never read then write.
 */
export interface QueueJobV1 {
  id: string;
  state: 'pending' | 'running' | 'completed';
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
