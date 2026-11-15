import type { FleetLaneView, FleetSessionsV1 } from '../../../data/api-types.js';
import type { QueueStatsView } from '../../../data/queue-stats/model.js';

export const shown = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';

export function recordedAt(value: unknown, now = Date.now()): string {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time > now) return 'Observation time unknown';
  const seconds = Math.floor((now - time) / 1000);
  return `${seconds > 120 ? 'Stale · ' : ''}recorded ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} ago`;
}

/** Queue drain is observed READY departures, not service capacity (mu). */
export function queueFlow(data: QueueStatsView) {
  const ready = data.stations.find(row => row.station === 'READY');
  return ready ? { depth: ready.currentQueueLength, drain: ready.departures * 3_600_000 / ready.windowMs } : null;
}

/** Finished includes failed jobs. The bounded tail is never advertised as a total. */
export function hourOutcomes(data: FleetSessionsV1) {
  const now = Date.parse(data.generatedAt);
  const rows = data.recent.filter(row => {
    const at = Date.parse(row.finishedAt ?? '');
    return at > now - 3_600_000 && at <= now;
  });
  const known = data.sourceState === 'healthy' && data.sources.metrics === 'healthy' && Number.isFinite(now);
  return {
    finished: known ? rows.length : null,
    failed: known ? rows.filter(row => row.outcome === 'failed').length : null,
    partial: data.truncated,
  };
}

export function usedFraction(lane: FleetLaneView): number | null {
  const left = lane.credit.remainingPct;
  return lane.credit.state === 'observed' && left !== null && Number.isFinite(left) && left >= 0 && left <= 100
    ? (100 - left) / 100 : null;
}

export function lanePresence(lane: FleetLaneView): string {
  if (lane.hold?.held) return 'blocked';
  if (lane.liveJobs !== null && lane.liveJobs > 0) return 'working';
  return lane.liveJobs === 0 && lane.hold?.held === false ? 'idle' : 'unknown';
}
