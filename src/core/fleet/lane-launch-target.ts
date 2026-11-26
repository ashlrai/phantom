/**
 * The concurrency a lane may launch against right now. The fleet controller
 * can tighten a lane below its configured target (load shedding); dispatchd
 * publishes that as `effective_target` in status.json lanes. It never exceeds
 * the configured target, and an absent or unknown reading keeps the target.
 */
export function laneLaunchTarget(target: number, effectiveTarget: number | null | undefined): number {
  return Math.min(target, effectiveTarget ?? target);
}

/** Remaining fleet slots from the admission snapshot embedded in this tick. */
export function dispatcherAdmissionHeadroom(admission: unknown, lastTick: unknown): number | null {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return null;
  const { ts, cap, running, admit, decision, gate_reason } = admission as Record<string, unknown>;
  if (ts !== undefined && ts !== lastTick) return null;
  const remaining = typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0 &&
    typeof running === 'number' && Number.isSafeInteger(running) && running >= 0
    ? Math.max(0, cap - running) : null;
  const stopped = admit === false || decision === 'stop' ||
    (typeof gate_reason === 'string' && gate_reason.trim().length > 0);
  return stopped ? 0 : remaining;
}
