/**
 * Historical projection of one recorded coding-CLI availability result. Pure
 * over caller-supplied evidence: no process, filesystem, env, home, clock,
 * network or installed-binary access. Recovered from PR #5952 (head
 * 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886): probe.ts probeAvailability() staging
 * and adapters.ts grokOutputIsMetered(). A command shape is not proof a binary
 * exists. An absent recording is 'unrecorded' (unknown), never a failure. Source
 * divergences are listed in BRIDGE_NOTES.md.
 */

import { isExitCode, isNonEmptyString, isRecord } from './validation.js';

export const RECORDED_AVAILABILITY_PROVENANCE = Object.freeze({
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourcePath: 'src/core/providers/coding-cli/probe.ts',
  sourceFunction: 'probeAvailability',
  meteredSource: 'src/core/providers/coding-cli/adapters.ts grokOutputIsMetered',
  basis: 'historical-offline',
  execution: 'none',
  liveEligibility: 'not-granted',
} as const);

/** Claims a recorded availability result never establishes. Always attached. */
export const UNPROVEN_AVAILABILITY_CLAIMS = Object.freeze([
  'current-binary-presence', 'current-login', 'current-health', 'quota', 'balance',
  'reset-window', 'paid-eligibility', 'permission-to-spend', 'dispatch-authority',
] as const);

/** Source metered wording, from adapters.ts grokOutputIsMetered(). */
const GROK_METERED_PATTERN = /XAI_API_KEY/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN_CLASSES: readonly string[] = ['in', 'out', 'unknown'];

/** Structural adapter shape. Its commands are configuration and are never executed. */
export interface RecordedAvailabilityAdapter {
  id: string;
  bin?: string | null;
  versionArgs: readonly string[];
  /** Null when the recorded backend had no status command. */
  statusArgs: readonly string[] | null;
  /** Billing as the caller recorded it. Never a derived eligibility verdict. */
  billing?: string | null;
}

export interface RecordedCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RecordedLoginClassification = 'in' | 'out' | 'unknown';

export interface RecordedAvailabilityEvidence {
  adapter: RecordedAvailabilityAdapter;
  /** Undefined or null means no version recording exists. */
  version?: RecordedCommandResult | null;
  /** Undefined or null means no status recording exists. */
  status?: RecordedCommandResult | null;
  /** Caller's historical login class. Consumed only after a recorded status. */
  login?: RecordedLoginClassification | null;
}

export type RecordedAvailabilityStage =
  | 'invalid-evidence'
  | 'no-binary-configured'
  | 'version-unrecorded'
  | 'version-nonzero-exit'
  | 'version-blank-output'
  | 'version-responded-no-status-command'
  | 'status-unrecorded'
  | 'status-recorded';

export type RecordedVersionCheck = 'not-configured' | 'unrecorded' | 'failed' | 'responded' | 'unknown';
export type RecordedStatusCheck = 'not-applicable' | 'not-reached' | 'unrecorded' | 'failed' | 'succeeded' | 'unknown';

export interface RecordedAvailabilityProjection {
  provenance: typeof RECORDED_AVAILABILITY_PROVENANCE;
  /** Adapter id when it passed validation, otherwise null. */
  id: string | null;
  stage: RecordedAvailabilityStage;
  versionCheck: RecordedVersionCheck;
  statusCheck: RecordedStatusCheck;
  login: RecordedLoginClassification;
  /** The caller's billing string as recorded, or null. Never reclassified. */
  billingAsRecorded: string | null;
  /** Grok only: status output carried the XAI_API_KEY wording. Observation only. */
  meteredStatusObservation: boolean;
  unprovenClaims: typeof UNPROVEN_AVAILABILITY_CLAIMS;
}

type Fields = Omit<RecordedAvailabilityProjection, 'provenance' | 'unprovenClaims'>;

function project(fields: Fields): RecordedAvailabilityProjection {
  return Object.freeze({ provenance: RECORDED_AVAILABILITY_PROVENANCE, ...fields, unprovenClaims: UNPROVEN_AVAILABILITY_CLAIMS });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The recording, null when absent, or undefined when present but malformed. */
function asRecording(value: unknown): RecordedCommandResult | null | undefined {
  if (value === undefined || value === null) return null;
  const ok =
    isRecord(value) &&
    isExitCode(value.code) &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string';
  return ok ? { code: value.code as number, stdout: value.stdout as string, stderr: value.stderr as string } : undefined;
}

/** The login class ('unknown' when absent), or undefined when malformed. */
function asLogin(value: unknown): RecordedLoginClassification | undefined {
  if (value === undefined || value === null) return 'unknown';
  return typeof value === 'string' && LOGIN_CLASSES.includes(value) ? (value as RecordedLoginClassification) : undefined;
}

/** Pure: the input is read, never mutated, and no captured text, argument or path is returned. */
export function projectRecordedAvailability(evidence: RecordedAvailabilityEvidence): RecordedAvailabilityProjection {
  const input: unknown = evidence;
  const adapter = isRecord(input) ? input.adapter : undefined;
  const id = isRecord(adapter) && typeof adapter.id === 'string' && ID_PATTERN.test(adapter.id) ? adapter.id : null;
  const invalid = (): RecordedAvailabilityProjection =>
    project({ id, stage: 'invalid-evidence', versionCheck: 'unknown', statusCheck: 'unknown', login: 'unknown', billingAsRecorded: null, meteredStatusObservation: false });
  if (!isRecord(input) || !isRecord(adapter) || id === null) return invalid();

  const bin = adapter.bin ?? null;
  const billing = adapter.billing ?? null;
  const version = asRecording(input.version);
  const status = asRecording(input.status);
  const login = asLogin(input.login);
  if (
    (bin !== null && typeof bin !== 'string') ||
    !isStringArray(adapter.versionArgs) ||
    (adapter.statusArgs !== null && !isStringArray(adapter.statusArgs)) ||
    (billing !== null && typeof billing !== 'string') ||
    version === undefined ||
    status === undefined ||
    login === undefined
  ) {
    return invalid();
  }

  const base = { id, billingAsRecorded: billing, meteredStatusObservation: false, login: 'unknown' } as const;

  // Stage 1. Source: `!adapter.bin || adapter.versionArgs.length === 0`.
  if (!isNonEmptyString(bin) || adapter.versionArgs.length === 0) {
    return project({ ...base, stage: 'no-binary-configured', versionCheck: 'not-configured', statusCheck: 'not-reached' });
  }
  // Absent is unknown, not failed. Status evidence is not read without a version.
  if (version === null) {
    return project({ ...base, stage: 'version-unrecorded', versionCheck: 'unrecorded', statusCheck: 'not-reached' });
  }
  // Stage 2. Source: `version.code !== 0 || version.stdout.trim() === ''`. Stdout only.
  if (version.code !== 0) {
    return project({ ...base, stage: 'version-nonzero-exit', versionCheck: 'failed', statusCheck: 'not-reached' });
  }
  if (version.stdout.trim() === '') {
    return project({ ...base, stage: 'version-blank-output', versionCheck: 'failed', statusCheck: 'not-reached' });
  }
  // Stage 3. Source: "binary present; login was not probed".
  if (adapter.statusArgs === null) {
    return project({ ...base, stage: 'version-responded-no-status-command', versionCheck: 'responded', statusCheck: 'not-applicable' });
  }
  if (status === null) {
    return project({ ...base, stage: 'status-unrecorded', versionCheck: 'responded', statusCheck: 'unrecorded' });
  }
  // Stage 4. 'in' needs a zero exit, as in the source. The wording is read whatever the exit code (source quirk).
  const succeeded = status.code === 0;
  const metered = id === 'grok' && GROK_METERED_PATTERN.test(`${status.stdout}\n${status.stderr}`);
  return project({
    id,
    stage: 'status-recorded',
    versionCheck: 'responded',
    statusCheck: succeeded ? 'succeeded' : 'failed',
    login: login === 'in' && !succeeded ? 'unknown' : login,
    billingAsRecorded: billing,
    meteredStatusObservation: metered,
  });
}
