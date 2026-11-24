/**
 * Historical classifier for one recorded model probe: did a recorded minimal
 * exec of a candidate model succeed? Pure over caller-supplied evidence. No
 * process, filesystem, env, clock, network or credential access.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * src/core/providers/coding-cli/adapters.ts interpretModelProbe(). Preserved:
 * nonzero exit rejects; the source rejection pattern is tested against stdout
 * and stderr together, so it rejects even on exit 0; whitespace-only output
 * rejects; otherwise the probe is accepted.
 *
 * HISTORICAL-ONLY SEMANTICS. 'accepted' means a recorded probe execution exited
 * 0 with non-rejection output. It is NOT proof of present model access, login,
 * quota, subscription inclusion, or dispatch authority (see
 * UNPROVEN_CLAIMS). A cache listing that names the candidate is not evidence:
 * without a recorded execution the outcome is 'unknown', never 'accepted'.
 *
 * Deliberate divergences from the source:
 * - No recorded execution returns 'unknown' / 'no-recorded-execution'. The
 *   source had no such input; its probeModel() returned 'rejected' when no
 *   verify path existed.
 * - Malformed evidence (non-boolean `observed`, missing or non-integer exit
 *   code, negative or > 2^32-1 exit code, non-string streams) returns
 *   'unknown' / 'invalid-evidence'. The source rejected any non-zero or NaN
 *   code without checking the shape.
 * - Reasons are fixed codes. Captured stdout/stderr is never echoed.
 */

export const RECORDED_MODEL_PROBE_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFunction: 'interpretModelProbe',
  basis: 'historical-offline',
} as const;

/** Claims an accepted historical probe never establishes. Always attached. */
export const UNPROVEN_CLAIMS = Object.freeze([
  'present-model-access',
  'login',
  'quota',
  'subscription-inclusion',
  'dispatch-authority',
] as const);

/** Source rejection pattern, copied verbatim from adapters.ts interpretModelProbe. */
const SOURCE_REJECTION_PATTERN = /not available|unknown model|does not exist|rejected|model .*not found|invalid model/i;

const MAX_EXIT_CODE = 0xffff_ffff;

/**
 * Caller-supplied record of one probe. `observed` must be true only when an
 * executable probe actually ran. When it is false, `exitCode`, `stdout` and
 * `stderr` are ignored, so a cache listing cannot influence the outcome.
 */
export interface RecordedModelProbeEvidence {
  observed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type RecordedModelProbeOutcome = 'accepted' | 'rejected' | 'unknown';

export type RecordedModelProbeReason =
  | 'probe-accepted'
  | 'probe-nonzero-exit'
  | 'probe-rejection-phrase'
  | 'probe-empty-output'
  | 'no-recorded-execution'
  | 'invalid-evidence';

export interface RecordedModelProbeClassification {
  provenance: typeof RECORDED_MODEL_PROBE_PROVENANCE;
  outcome: RecordedModelProbeOutcome;
  reason: RecordedModelProbeReason;
  /** 'historical-probe-only' when accepted; null otherwise. */
  acceptance: 'historical-probe-only' | null;
  /** Claims this result does not establish. Always the full list. */
  unprovenClaims: typeof UNPROVEN_CLAIMS;
}

function classification(outcome: RecordedModelProbeOutcome, reason: RecordedModelProbeReason): RecordedModelProbeClassification {
  return Object.freeze({
    provenance: RECORDED_MODEL_PROBE_PROVENANCE,
    outcome,
    reason,
    acceptance: outcome === 'accepted' ? 'historical-probe-only' : null,
    unprovenClaims: UNPROVEN_CLAIMS,
  });
}

function isExitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_EXIT_CODE;
}

/**
 * Classify one recorded probe. Pure: the input is read, never mutated, and no
 * captured text appears in the result.
 */
export function classifyRecordedModelProbe(evidence: RecordedModelProbeEvidence): RecordedModelProbeClassification {
  if (typeof evidence !== 'object' || evidence === null || typeof evidence.observed !== 'boolean') {
    return classification('unknown', 'invalid-evidence');
  }
  if (!evidence.observed) return classification('unknown', 'no-recorded-execution');
  const { exitCode, stdout, stderr } = evidence;
  if (!isExitCode(exitCode) || typeof stdout !== 'string' || typeof stderr !== 'string') {
    return classification('unknown', 'invalid-evidence');
  }
  if (exitCode !== 0) return classification('rejected', 'probe-nonzero-exit');
  // Same combination as the source: stdout, a newline, then stderr.
  const text = `${stdout}\n${stderr}`;
  if (SOURCE_REJECTION_PATTERN.test(text)) return classification('rejected', 'probe-rejection-phrase');
  if (text.trim() === '') return classification('rejected', 'probe-empty-output');
  return classification('accepted', 'probe-accepted');
}
