import { QUEUE_STATUSES, type QueueStatus } from '../queue/schema.js';
import type { DriveJob } from './supervisor.js';

/**
 * Structural read seam for the queue.v1 contract in ../queue/schema.ts. The
 * full document remains owned/validated by its queue store. The host bridge
 * can pass a validated QueueDocument directly here.
 */
export interface DriveQueueV1 {
  schema: 'queue.v1';
  jobs: {
    id: string;
    status: QueueStatus;
    priority: string;
    pool: string;
    tier: string;
    repo: string;
    deps: string[];
  }[];
}

/**
 * Conservative scheduling view, before applying verified runner receipts.
 * CLAIMED consumes a slot even when the imported claim has no known owner.
 * DONE and PR-OPEN do not prove worker completion or publisher success.
 */
export function projectDriveQueueV1(queue: DriveQueueV1): DriveJob[] {
  if (queue.schema !== 'queue.v1' || !Array.isArray(queue.jobs)) throw new Error('Expected DRIVER-1 queue.v1');
  const ids = new Set(queue.jobs.map(job => job.id));
  if (ids.size !== queue.jobs.length) throw new Error('Duplicate DRIVER-1 job');
  const completed = new Set(queue.jobs.filter(job => job.status === 'DONE').map(job => job.id));
  const validStatuses = new Set<string>(QUEUE_STATUSES);
  return queue.jobs.map(job => {
    if (!validStatuses.has(job.status) || !Array.isArray(job.deps) ||
        job.deps.some(dep => typeof dep !== 'string' || dep === job.id) ||
        [job.id, job.pool, job.tier, job.repo, job.priority].some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('Invalid DRIVER-1 scheduling fields');
    }
    const priority = /^P([0-9])$/.exec(job.priority);
    const routed = [job.pool, job.tier, job.repo].every(value => value !== 'unspecified');
    const ready = job.status === 'READY' && priority !== null && routed && job.deps.every(dep => completed.has(dep));
    return { id: job.id, pool: job.pool, priority: priority ? 9 - Number(priority[1]) : 0,
      state: job.status === 'CLAIMED' ? 'STARTING' : ready ? 'READY' : 'HELD' };
  });
}
