/**
 * When a persisted `running` run is probably orphaned.
 *
 * A run record carries no owner process, so a run whose process was killed
 * (crash, SIGKILL, reboot) stays `running` on disk forever. The record itself
 * is left alone on purpose: rewriting it could replay or hide work that may
 * have executed. Readers label it instead. `updatedAt` is written after every
 * step, so a long quiet stretch means no live loop is advancing it.
 */

/** A `running` run with no update for this long is flagged stale (likely orphaned). Same threshold as the app timeline (verse/fleet-history.ts). */
export const STALE_RUNNING_MS = 30 * 60 * 1000;

/** True when a run claims `running` but has not been updated for STALE_RUNNING_MS. */
export function isStaleRunning(
  run: { status: string; updatedAt: string },
  nowMs: number = Date.now(),
): boolean {
  if (run.status !== 'running') return false;
  const updatedMs = Date.parse(run.updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_RUNNING_MS;
}
