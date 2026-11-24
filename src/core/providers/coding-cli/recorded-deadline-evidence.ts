/**
 * Historical deadline-urgency calculation over one recorded allowance. Pure,
 * recorded input only (no clock, env, filesystem, network or provider reads).
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/pools.ts loseItUrgency(). Behavior preserved: an expiry counts only
 * when strictly after `asOfMs` and strictly before a known reset (an expiry equal
 * to the reset is not a candidate; the reset covers it unless carryover); a reset
 * counts only when strictly after `asOfMs` and the allowance does not carry over;
 * the earliest candidate wins; urgency is clamp(1 - (deadline - asOf) / window,
 * 0, 1) with a seven-day default window. A non-finite expiry or reset is treated
 * as unknown, as in the source.
 *
 * Deliberate difference: a non-finite `asOfMs`, or a supplied window that is not
 * a finite number > 0, throws RangeError (the source computed NaN/Infinity or
 * divided by zero). A null/undefined window still means the seven-day default.
 *
 * Urgency 0 with `deadline: null` means NO DEADLINE EVIDENCE. It is not proof of
 * available allowance, live quota, or that work may proceed. This is a historical
 * calculation for explaining recorded plans; it never authorizes work, paid
 * fallback, reserves, resets or dispatch.
 */

export const RECORDED_DEADLINE_EVIDENCE_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

export const DEFAULT_DEADLINE_WINDOW_MS = 7 * 86_400_000;

export interface RecordedDeadlineInput {
  /** Recorded expiry (epoch ms) of the expiring allowance; null/unknown = none. */
  expiresAtMs?: number | null;
  /** Recorded next reset (epoch ms); null/unknown = none. */
  resetAtMs?: number | null;
  /** True when unused allowance survives the reset. */
  carryover: boolean;
  /** Recorded window length in ms; null/undefined uses the seven-day default. */
  resetEveryMs?: number | null;
  /** Explicit evaluation instant (epoch ms). */
  asOfMs: number;
}

export type RecordedDeadlineReason = 'expiry' | 'reset' | 'no-deadline-evidence';

export interface RecordedDeadlineEvidence {
  /** Selected deadline (epoch ms), or null when there is no deadline evidence. */
  deadlineMs: number | null;
  reason: RecordedDeadlineReason;
  /** Urgency in [0, 1]. 0 with no deadline means "no evidence", not "plenty left". */
  urgency: number;
  windowMs: number;
  provenance: typeof RECORDED_DEADLINE_EVIDENCE_PROVENANCE;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function recordedDeadlineEvidence(input: RecordedDeadlineInput): RecordedDeadlineEvidence {
  const { asOfMs, carryover } = input;
  if (!isFiniteNumber(asOfMs)) throw new RangeError('asOfMs must be a finite number');
  const supplied = input.resetEveryMs;
  if (supplied !== null && supplied !== undefined && !(isFiniteNumber(supplied) && supplied > 0)) {
    throw new RangeError('resetEveryMs must be a finite number > 0 when supplied');
  }
  const windowMs = supplied ?? DEFAULT_DEADLINE_WINDOW_MS;

  const expiry = input.expiresAtMs;
  const reset = input.resetAtMs;
  const resetKnown = isFiniteNumber(reset);
  const candidates: { at: number; reason: 'expiry' | 'reset' }[] = [];
  if (isFiniteNumber(expiry) && expiry > asOfMs && (!resetKnown || expiry < reset)) {
    candidates.push({ at: expiry, reason: 'expiry' });
  }
  if (!carryover && resetKnown && reset > asOfMs) candidates.push({ at: reset, reason: 'reset' });

  if (candidates.length === 0) {
    return {
      deadlineMs: null,
      reason: 'no-deadline-evidence',
      urgency: 0,
      windowMs,
      provenance: RECORDED_DEADLINE_EVIDENCE_PROVENANCE,
    };
  }
  // Candidates are distinct by construction (expiry < reset), so ordering is total.
  const picked = candidates.reduce((a, b) => (b.at < a.at ? b : a));
  const urgency = Math.max(0, Math.min(1, 1 - (picked.at - asOfMs) / windowMs));
  return {
    deadlineMs: picked.at,
    reason: picked.reason,
    urgency,
    windowMs,
    provenance: RECORDED_DEADLINE_EVIDENCE_PROVENANCE,
  };
}
