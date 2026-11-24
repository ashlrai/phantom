/**
 * The wire contract for the launch-order queue view and its three actions.
 * Shared by `phm queue`, GET/POST /api/verse/fleet/queue/order and the desktop
 * Queue pane. No Node imports: the web UI loads this file.
 */
export const VERSE_FLEET_QUEUE_ORDER_PATH = '/api/verse/fleet/queue/order';
export const QUEUE_ORDER_ACTIONS = ['top', 'lane', 'drop'] as const;
export type QueueOrderAction = (typeof QUEUE_ORDER_ACTIONS)[number];

export interface QueueOrderJob {
  /** 1 launches first. Parked rows are not counted. */
  position: number;
  id: string; repo: string; lane: string; tier: string;
  /** Seconds since the job's prompt was written; null when unknown. */
  ageSeconds: number | null;
  /** The id without its cycle (RQ-PHX-RECUTCORE for RQ-PHX-RECUTCOREC541); null when the id has no cycle. */
  family: string | null;
  /** The newer queued cycle of the same family that replaces this job, or null. */
  supersededBy: string | null;
}
export interface QueueOrderV1 {
  schema: 'queue.order.v1'; version: 1; generatedAt: string;
  count: number;
  /** Rows held out of launch (PARKED-*); not listed. */
  parked: number;
  /** Lanes a job can move to: known and not held. */
  lanes: string[];
  jobs: QueueOrderJob[];
}
export interface QueueActionRequest { action: QueueOrderAction; id: string; lane?: string; dryRun?: boolean }
export interface QueueActionV1 {
  schema: 'queue.action.v1'; version: 1;
  action: QueueOrderAction; id: string; dryRun: boolean;
  /** False when the queue already was the way the action wants it. */
  changed: boolean;
  /** True once a re-read shows the change in place; null for a dry run or no change. */
  verified: boolean | null;
  from: { position: number; of: number; lane: string };
  /** Where the job is after the action; null position after a drop. */
  to: { position: number | null; lane: string };
  /** Files written beside ready.tsv: the copy taken before the edit and the archive of dropped rows. */
  backup: string | null; archive: string | null;
  /** One plain sentence saying what changed. */
  message: string;
}
export type QueueSteerCode = 'job-not-found' | 'lane-closed' | 'queue-missing' | 'queue-busy';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function isQueueOrder(value: unknown): value is QueueOrderV1 {
  return record(value) && value.schema === 'queue.order.v1' && value.version === 1 && Array.isArray(value.jobs) && Array.isArray(value.lanes)
    && value.jobs.every(job => record(job) && typeof job.id === 'string' && typeof job.lane === 'string' && typeof job.position === 'number');
}
export function isQueueAction(value: unknown): value is QueueActionV1 {
  return record(value) && value.schema === 'queue.action.v1' && value.version === 1 && typeof value.message === 'string' && typeof value.changed === 'boolean';
}
/** A short age: 45s, 10m, 3h, 2d. */
export const queueAgeText = (s: number | null): string => s === null ? 'age unknown' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
