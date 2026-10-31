import type { FleetQueueV1 } from '../ops/ops-queue-model.js';

export function queueHeadline(q: FleetQueueV1): string {
  return `${q.ready} ready · ${q.parked} parked${q.skipsLast24h === null ? '' : ` · ${q.skipsLast24h} skips/24 h`}`;
}

export function laneRows(q: FleetQueueV1): FleetQueueV1['byLane'] {
  return [...q.byLane].sort((a, b) => b.parked - a.parked || a.lane.localeCompare(b.lane));
}

export function groupRows(q: FleetQueueV1, maxJobs = 4) {
  return q.groups.map(({ reason, lane, count, jobs }) => {
    const shown = jobs.slice(0, Math.max(0, maxJobs));
    return { reason, lane: lane ?? 'any lane', count, jobs: shown, more: Math.max(0, count - shown.length) };
  });
}

export function skipRows(q: FleetQueueV1, limit = 5): FleetQueueV1['skips'] {
  const time = (at: string) => {
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };
  return [...q.skips].sort((a, b) => time(b.at) - time(a.at)).slice(0, Math.max(0, limit));
}

export function queueTone(q: FleetQueueV1): 'danger' | 'warn' | 'ok' | 'neutral' {
  if (q.total === 0) return 'neutral';
  if (q.parked > 0) return q.ready === 0 ? 'danger' : 'warn';
  return 'ok';
}
