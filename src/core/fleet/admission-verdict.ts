/**
 * The fleet-wide admission verdict both `fleet admission` and `fleet lane-idle`
 * report from `queue/status.json`. One derivation so the two commands can never
 * disagree: the global cap, a gate reason, a pause or a stop verdict all mean
 * nothing new launches this tick; a block the cap cannot explain (gate, pause,
 * or a stop verdict while under the cap) outranks the cap itself.
 */
export interface FleetAdmissionVerdict {
  /** Global running is at or over the dispatcher cap. */
  atCap: boolean;
  /** The dispatcher admits no new claims this tick for any reason. */
  closed: boolean;
  /** Admission is closed by the load gate or a pause rather than only the cap. */
  nonCapClosed: boolean;
}

export function fleetAdmissionVerdict(input: {
  atCap: boolean;
  admit?: unknown;
  decision?: unknown;
  /** Normalized gate_reason: a plain string or null; empty counts as absent. */
  gateReason?: string | null;
  paused?: unknown;
}): FleetAdmissionVerdict {
  const stopped = input.admit === false || input.decision === 'stop';
  const gated = Boolean(input.gateReason);
  const paused = Boolean(input.paused);
  const nonCapClosed = gated || paused || (stopped && !input.atCap);
  const closed = input.atCap || stopped || gated || paused;
  return { atCap: input.atCap, closed, nonCapClosed };
}
