import type { MergeQueueStatus } from '../fleet/merge-queue-status.js';

export interface QueueWaitInput {
  known: boolean; ignored_events: number;
  queue_timelines: Array<{ repo: string; pr: number; queue_observed: boolean;
    enqueued_at: string | null; current_dwell_s: number | null; status: MergeQueueStatus }> | null;
}
export interface QueueWaitReport {
  schema: 'queue.wait.v1'; source: 'recorded_events'; observedAt: string;
  readOnly: true; requiredChecksPreserved: true; state: 'queued' | 'empty' | 'unknown';
  oldestQueued: { repo: string; pr: number; enqueuedAt: string; waitingSeconds: number;
    reason: MergeQueueStatus['stage']; reasonSince: string | null } | null;
}

/** Never claim an oldest entry when missing or repeated evidence could hide an older one. */
export function queueWait(input: QueueWaitInput, now = Date.now()): QueueWaitReport {
  const queued = (input.queue_timelines ?? []).filter(row => row.queue_observed
    && row.status.stage !== 'merged' && row.status.stage !== 'closed');
  const unknown = !input.known || input.queue_timelines === null || input.ignored_events > 0
    || queued.some(row => row.enqueued_at === null || row.current_dwell_s === null);
  const oldest = unknown ? undefined : queued.sort((a, b) => Date.parse(a.enqueued_at!) - Date.parse(b.enqueued_at!)
    || a.repo.localeCompare(b.repo) || a.pr - b.pr)[0];
  return { schema: 'queue.wait.v1', source: 'recorded_events', observedAt: new Date(now).toISOString(),
    readOnly: true, requiredChecksPreserved: true, state: unknown ? 'unknown' : oldest ? 'queued' : 'empty',
    oldestQueued: oldest ? { repo: oldest.repo, pr: oldest.pr, enqueuedAt: oldest.enqueued_at!,
      waitingSeconds: oldest.current_dwell_s!, reason: oldest.status.stage, reasonSince: oldest.status.since } : null };
}
