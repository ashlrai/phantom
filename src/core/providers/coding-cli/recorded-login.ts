/**
 * Historical classifier for one recorded coding-CLI login status check. Pure:
 * caller-supplied evidence only; no process, fs, env, network or credentials.
 * Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * adapters.ts interpretLogin(). Preserved: the logged-out pattern wins on any
 * exit code, even when the text also says "logged in"; else exit 0 plus the
 * logged-in pattern is 'logged-in'; else 'unknown'. Patterns are verbatim.
 * HISTORICAL-ONLY, live=false: never present login, quota, billing eligibility,
 * model access or dispatch authority. Divergences (BRIDGE_NOTES.md): unobserved
 * is 'no-recorded-execution'; malformed is 'invalid-evidence'; stdout and stderr
 * are joined by '\n', so no phrase spans streams; fixed reason codes, no output echoed.
 */

export const RECORDED_LOGIN_PROVENANCE = Object.freeze({
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFunction: 'interpretLogin',
  basis: 'historical-offline',
} as const);

/** Claims a recorded login never establishes. Attached to every result. */
export const RECORDED_LOGIN_UNPROVEN_CLAIMS = Object.freeze([
  'present-login',
  'quota',
  'billing-eligibility',
  'model-access',
  'dispatch-authority',
] as const);

const LOGGED_OUT_PATTERN = /not logged in|login expired|please run .*login|sign in/i;
const LOGGED_IN_PATTERN = /logged in|signed in/i;

/** Caller-supplied record of one status check. Other fields are ignored when observed is false. */
export interface RecordedLoginEvidence {
  observed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RecordedLoginOutcome = 'logged-in' | 'logged-out' | 'unknown';

export type RecordedLoginReason = 'logged-out-phrase' | 'logged-in-phrase' | 'nonzero-exit'
  | 'insufficient-evidence' | 'no-recorded-execution' | 'invalid-evidence';

export interface RecordedLoginClassification {
  provenance: typeof RECORDED_LOGIN_PROVENANCE;
  /** Always false. Recorded evidence is never live. */
  live: false;
  outcome: RecordedLoginOutcome;
  reason: RecordedLoginReason;
  unprovenClaims: typeof RECORDED_LOGIN_UNPROVEN_CLAIMS;
}

function result(outcome: RecordedLoginOutcome, reason: RecordedLoginReason): RecordedLoginClassification {
  return Object.freeze({ provenance: RECORDED_LOGIN_PROVENANCE, live: false, outcome, reason,
    unprovenClaims: RECORDED_LOGIN_UNPROVEN_CLAIMS });
}

/** Classify recorded status evidence. Never throws, never echoes captured output. */
export function classifyRecordedLogin(evidence: RecordedLoginEvidence): RecordedLoginClassification {
  const shape: unknown = evidence;
  if (typeof shape !== 'object' || shape === null) return result('unknown', 'invalid-evidence');
  // Read each field once so getters cannot change the outcome between checks.
  const { observed, exitCode, stdout, stderr } = shape as Record<string, unknown>;
  if (typeof observed !== 'boolean') return result('unknown', 'invalid-evidence');
  if (!observed) return result('unknown', 'no-recorded-execution');
  const validExit = Number.isInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) <= 0xffff_ffff;
  if (!validExit || typeof stdout !== 'string' || typeof stderr !== 'string') {
    return result('unknown', 'invalid-evidence');
  }
  const text = `${stdout}\n${stderr}`;
  if (LOGGED_OUT_PATTERN.test(text)) return result('logged-out', 'logged-out-phrase');
  if (exitCode !== 0) return result('unknown', 'nonzero-exit');
  if (LOGGED_IN_PATTERN.test(text)) return result('logged-in', 'logged-in-phrase');
  return result('unknown', 'insufficient-evidence');
}
