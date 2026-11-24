/**
 * Historical runway of one recorded assignment batch against one recorded
 * allowance window. Pure: explicit recorded inputs only (no clock, env,
 * filesystem, network or state writes).
 *
 * The result is a HISTORICAL CALCULATION, never a live quota read and never
 * dispatch permission. `runwayHours` is POST-BATCH runway: how long the
 * recorded remaining fraction, after this batch's recorded demand, would last
 * if the batch's burn repeated once per recorded pace tick. It can exceed the
 * time to reset. A zero-spend result is only the time-to-reset fallback; it is
 * not a burn-rate estimate and not proof of unlimited allowance.
 *
 * Boundary: the caller resolves job/pool lookup and default demand OUTSIDE this
 * function and passes already-resolved demand rows. An absent job or absent
 * demand must be omitted or reported as missing evidence by the caller; this
 * function never invents an observation for it (the source silently skipped
 * assignments whose job or pool was not found, and defaulted demand to a
 * configured Grok fraction or 1).
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/solve.ts runwayHours() and demandOf(). Arithmetic preserved:
 *   timeLeftHours = max(0, resetAtMs - asOfMs) / 3_600_000
 *   spent         = sum of demand over rows of the selected pool
 *   spent <= 1e-12 -> runway = timeLeftHours
 *   else           -> runway = max(0, ((remaining - spent) / spent) * (paceTickMs / 3_600_000))
 *
 * Deliberate differences from the source: the selected pool is an explicit
 * input (no Grok pool id); `nowMs` is `asOfMs`; non-finite times/fractions/
 * demands, negative demand, remaining outside [0,1] and non-positive pace throw
 * RangeError (the source clamped or passed them through); missing evidence
 * (null/undefined input) returns an explicit `unknown` result, never 0.
 */

export const RECORDED_ASSIGNMENT_RUNWAY_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'historical-offline',
} as const;

const HOUR_MS = 3_600_000;
/** Spend at or below this is treated as no spend (source epsilon). */
export const RECORDED_RUNWAY_SPEND_EPSILON = 1e-12;

/** One already-resolved assignment demand: fraction of `poolId`'s window. */
export interface RecordedAssignmentDemand {
  poolId: string;
  demand: number;
}

export interface RecordedAssignmentRunwayInput {
  /** The recorded pool whose demand is summed. Explicit; never defaulted. */
  poolId: string;
  asOfMs?: number | null;
  resetAtMs?: number | null;
  /** Recorded remaining fraction of the window before the batch, in [0,1]. */
  remainingFraction?: number | null;
  /** Recorded pace tick in ms; only needed when the batch has spend. */
  paceTickMs?: number | null;
  /** Resolved demand rows; null/undefined means demand evidence is missing. */
  demands?: readonly RecordedAssignmentDemand[] | null;
}

export type RecordedRunwayBasis = 'time-to-reset-fallback' | 'burn-rate-estimate';

export type RecordedRunwayUnknownField = 'asOfMs' | 'resetAtMs' | 'remainingFraction' | 'paceTickMs' | 'demands';

interface RunwayCommon {
  kind: 'historical-recorded-assignment-runway';
  provenance: typeof RECORDED_ASSIGNMENT_RUNWAY_PROVENANCE;
  /** Always false: this is never a live quota read or dispatch permission. */
  liveQuota: false;
  poolId: string;
}

export interface RecordedAssignmentRunwayKnown extends RunwayCommon {
  status: 'known';
  basis: RecordedRunwayBasis;
  spentFraction: number;
  timeLeftHours: number;
  runwayHours: number;
  /** True when the recorded batch demand meets or exceeds recorded remaining. */
  exhaustsAllowance: boolean;
  evidence: { asOfMs: number; resetAtMs: number; remainingFraction: number; paceTickMs: number | null };
}

export interface RecordedAssignmentRunwayUnknown extends RunwayCommon {
  status: 'unknown';
  missing: readonly RecordedRunwayUnknownField[];
}

export type RecordedAssignmentRunway = RecordedAssignmentRunwayKnown | RecordedAssignmentRunwayUnknown;

function finite(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number`);
  }
  return value;
}

const absent = (v: unknown): boolean => v === null || v === undefined;

export function recordedAssignmentRunway(input: RecordedAssignmentRunwayInput): RecordedAssignmentRunway {
  const { poolId } = input;
  if (typeof poolId !== 'string' || poolId.length === 0) throw new RangeError('poolId must be a non-empty string');

  // Validate everything supplied before deciding anything is unknown, so bad
  // data is never masked by an unrelated missing field.
  if (!absent(input.asOfMs)) finite('asOfMs', input.asOfMs as number);
  if (!absent(input.resetAtMs)) finite('resetAtMs', input.resetAtMs as number);
  if (!absent(input.remainingFraction)) {
    const r = finite('remainingFraction', input.remainingFraction as number);
    if (r < 0 || r > 1) throw new RangeError('remainingFraction must be within [0,1]');
  }
  if (!absent(input.paceTickMs)) {
    const p = finite('paceTickMs', input.paceTickMs as number);
    if (p <= 0) throw new RangeError('paceTickMs must be positive');
  }
  let spent = 0;
  if (!absent(input.demands)) {
    for (const row of input.demands as readonly RecordedAssignmentDemand[]) {
      const d = finite('demand', row.demand);
      if (d < 0) throw new RangeError('demand must not be negative');
      if (row.poolId === poolId) spent += d;
    }
  }

  const base = {
    kind: 'historical-recorded-assignment-runway',
    provenance: RECORDED_ASSIGNMENT_RUNWAY_PROVENANCE,
    liveQuota: false,
    poolId,
  } as const;

  const missing: RecordedRunwayUnknownField[] = [];
  if (absent(input.asOfMs)) missing.push('asOfMs');
  if (absent(input.resetAtMs)) missing.push('resetAtMs');
  if (absent(input.remainingFraction)) missing.push('remainingFraction');
  if (absent(input.demands)) missing.push('demands');
  // Pace is only consulted on the burn path, as in the source.
  if (absent(input.paceTickMs) && spent > RECORDED_RUNWAY_SPEND_EPSILON) missing.push('paceTickMs');
  if (missing.length > 0) return { ...base, status: 'unknown', missing };

  const asOfMs = input.asOfMs as number;
  const resetAtMs = input.resetAtMs as number;
  const remaining = input.remainingFraction as number;
  const paceTickMs = absent(input.paceTickMs) ? null : (input.paceTickMs as number);
  const timeLeftHours = Math.max(0, resetAtMs - asOfMs) / HOUR_MS;
  const evidence = { asOfMs, resetAtMs, remainingFraction: remaining, paceTickMs };

  if (spent <= RECORDED_RUNWAY_SPEND_EPSILON) {
    return {
      ...base,
      status: 'known',
      basis: 'time-to-reset-fallback',
      spentFraction: spent,
      timeLeftHours,
      runwayHours: timeLeftHours,
      exhaustsAllowance: false,
      evidence,
    };
  }
  return {
    ...base,
    status: 'known',
    basis: 'burn-rate-estimate',
    spentFraction: spent,
    timeLeftHours,
    runwayHours: Math.max(0, ((remaining - spent) / spent) * ((paceTickMs as number) / HOUR_MS)),
    exhaustsAllowance: spent >= remaining,
    evidence,
  };
}
