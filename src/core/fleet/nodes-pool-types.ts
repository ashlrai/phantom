/** Shared by the server reader and the Verse UI. */
type Unknown = 'unknown';
export const NODES_POOL_SCHEMA = 'phantom.nodes-pool.v1';
export type PoolStatus = 'online' | 'offline' | 'unknown';
export type PoolOffload = 'on' | 'off' | 'unknown';

export interface PoolNode {
  name: string;
  isSelf: boolean;
  status: PoolStatus;
  /** Jobs this Mac could take now: 0 when offline or holding, "unknown" when not measured. */
  freeSlots: number | Unknown;
  /** IDs of the jobs it is running; "unknown" when the registry cannot say. */
  jobsRunning: string[] | Unknown;
  load: number | Unknown;
  freeMemoryBytes: number | Unknown;
  freeMemoryPercent: number | Unknown;
  freeDiskGb: number | Unknown;
  offload: PoolOffload;
  /** ISO time the Mac was last seen; "unknown" when never. */
  lastSeen: string | Unknown;
  /** The same state in plain words. */
  state: string;
}
export interface PoolTotal {
  macs: number;
  online: number;
  /** Free slots on online Macs, counting only the ones measured. */
  freeSlots: number;
  /** Online Macs whose free slots are not measured, so the total is at least this many. */
  slotsUnknown: number;
  jobsRunning: number;
  /** "2 Macs, 11 free slots" */
  line: string;
}
export interface NodesPool {
  schema: typeof NODES_POOL_SCHEMA;
  schemaVersion: 1;
  asOf: string;
  nodes: PoolNode[];
  total: PoolTotal;
  reasons: string[];
}

/** "seen 3 min ago" from two ISO times; "seen time unknown" when either is unreadable. */
export function seenWords(lastSeen: string | Unknown, asOf: string | Unknown): string {
  const age = Date.parse(asOf) - Date.parse(lastSeen);
  if (lastSeen === 'unknown' || !Number.isFinite(age)) return 'seen time unknown';
  const minutes = Math.round(Math.max(0, age) / 60_000);
  return minutes < 1 ? 'seen just now' : minutes < 60 ? `seen ${minutes} min ago` : minutes < 48 * 60 ? `seen ${Math.round(minutes / 60)} h ago` : `seen ${Math.round(minutes / 1440)} days ago`;
}
