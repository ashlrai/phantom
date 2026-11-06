import { RECOVERY_PROBE_MS } from './lane-health.js';
import type { DriveJob } from './supervisor.js';

/** Consecutive empty, nonzero-exit finishes that open a lane's breaker. */
export const LANE_BREAKER_STREAK = 5;

export type LaneBreakerState = 'closed' | 'open' | 'probing';
export interface LaneBreaker {
  pool: string;
  /** closed: pool dispatches. open: held until probeAtMs. probing: a recovery job may run. */
  state: LaneBreakerState;
  /** Why the breaker tripped; null while closed. */
  reason: string | null;
  /** Earliest ms a recovery probe may run; null while closed. */
  probeAtMs: number | null;
}

/**
 * claudeApiHealth generalized to one breaker per job pool, replaying the same
 * retained finishes (completedAtMs <= nowMs) in time order — except evidence
 * never expires, so a quiet hour cannot itself prove recovery. A pool opens
 * after LANE_BREAKER_STREAK consecutive finishes that are empty with a
 * nonzero exit code, admits a probe RECOVERY_PROBE_MS after its last finish,
 * and closes only on a non-empty finish with exit code 0. Any other finish
 * shape breaks the streak without closing an open breaker, and finishes in
 * one pool never affect another. Pure: no clock, file or network access.
 */
export function laneBreakers(jobs: readonly DriveJob[], nowMs: number): LaneBreaker[] {
  const finishes = new Map<string, DriveJob[]>();
  const pools = new Set<string>();
  for (const job of jobs) {
    pools.add(job.pool);
    if (job.completedAtMs === undefined || job.completedAtMs > nowMs) continue;
    const list = finishes.get(job.pool) ?? [];
    list.push(job);
    finishes.set(job.pool, list);
  }
  const breakers: LaneBreaker[] = [];
  for (const pool of [...pools].sort()) {
    let streak = 0;
    let tripped = false;
    let probeAtMs: number | null = null;
    const ordered = (finishes.get(pool) ?? []).sort((a, b) => a.completedAtMs! - b.completedAtMs!);
    for (const job of ordered) {
      if (job.exitCode === 0 && job.emptyFinish === false) {
        streak = 0;
        tripped = false;
        probeAtMs = null;
        continue;
      }
      streak = job.emptyFinish === true && typeof job.exitCode === 'number' && job.exitCode !== 0
        ? streak + 1 : 0;
      if (streak >= LANE_BREAKER_STREAK) tripped = true;
      if (tripped) probeAtMs = job.completedAtMs! + RECOVERY_PROBE_MS;
    }
    breakers.push({ pool, reason: tripped ? 'empty-nonzero-streak' : null, probeAtMs,
      state: !tripped ? 'closed' : nowMs >= probeAtMs! ? 'probing' : 'open' });
  }
  return breakers;
}
