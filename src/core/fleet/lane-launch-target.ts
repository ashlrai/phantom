/**
 * The concurrency a lane may launch against right now. The fleet controller
 * can tighten a lane below its configured target (load shedding); dispatchd
 * publishes that as `effective_target` in status.json lanes. It never exceeds
 * the configured target, and an absent or unknown reading keeps the target.
 */
export function laneLaunchTarget(target: number, effectiveTarget: number | null | undefined): number {
  return Math.min(target, effectiveTarget ?? target);
}

/**
 * Free launch slots a lane can use right now: the launch target minus
 * running, floored at zero, and zero while the lane is held — a held lane
 * cannot launch even when it sits below target.
 */
export function laneLaunchHeadroom(input: {
  held: boolean;
  running: number;
  target: number;
  effectiveTarget?: number | null;
}): number {
  return input.held ? 0 : Math.max(0, laneLaunchTarget(input.target, input.effectiveTarget) - input.running);
}
