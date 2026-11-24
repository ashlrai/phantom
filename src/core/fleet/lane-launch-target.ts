/**
 * The concurrency a lane may launch against right now. The fleet controller
 * can tighten a lane below its configured target (load shedding); dispatchd
 * publishes that as `effective_target` in status.json lanes. It never exceeds
 * the configured target, and an absent or unknown reading keeps the target.
 */
export function laneLaunchTarget(target: number, effectiveTarget: number | null | undefined): number {
  return Math.min(target, effectiveTarget ?? target);
}
