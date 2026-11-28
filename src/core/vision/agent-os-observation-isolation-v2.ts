/**
 * Signed, mismatch-resistant observation records for a future local-container broker.
 *
 * These pure records bind pre-start and post-run claims to one request nonce,
 * container identity, immutable implementation/configuration digests, resource
 * limits, and removal evidence. They do not contact Docker, provision keys,
 * launch work, or establish that a broker's claims are independently true.
 */

import {
  canonicalEpochDomainBytes as domainBytes,
  canonicalEpochJson as canonicalJson,
  canonicalEpochJsonDigest as digest,
  decodeEpochBase64url,
  deepFreezeEpochValue as deepFreeze,
  epochPlainRecord as record,
  exactEpochBytes as exactBytes,
  exactEpochKeys as exactKeys,
  immutablePlainDataSnapshot as immutableDataSnapshot,
  isValidEpochTimestamp as timestamp,
  isValidRawEpochDigest as rawDigest,
  matchesEpochAuthority,
} from './agent-os-epoch-shared.js';
import {
  inspectAgentOsLocalContainerCreatePolicyV1,
  isAgentOsLocalContainerLimitsV1,
  type AgentOsLocalContainerLimitsV1,
} from './agent-os-local-container-policy.js';

export const AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 =
  'ashlr-agent-os-observation-isolation-v2' as const;
export const AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2 = 'ed25519' as const;
const AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2 = 5 * 60_000;
const AGENT_OS_OBSERVATION_ISOLATION_MAX_FUTURE_SKEW_MS_V2 = 5_000;
const AGENT_OS_OBSERVATION_ISOLATION_MAX_DEADLINE_KILL_LAG_MS_V2 = 5_000;
const AGENT_OS_OBSERVATION_ISOLATION_MAX_CLEANUP_DURATION_MS_V2 = 10_000;

const PREPARE_SIGNATURE_DOMAIN = 'ashlr:agent-os:observation-isolation:prepare-signature:v2\0';
const PREPARE_DIGEST_DOMAIN = 'ashlr:agent-os:observation-isolation:prepare-digest:v2\0';
const FINALIZE_SIGNATURE_DOMAIN = 'ashlr:agent-os:observation-isolation:finalize-signature:v2\0';
const FINALIZE_DIGEST_DOMAIN = 'ashlr:agent-os:observation-isolation:finalize-digest:v2\0';

export const AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2 = Object.freeze({
  authority: 'observation-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
  containerProvisioningAuthority: false as const,
  isolationEnforcementAuthority: false as const,
});

export interface AgentOsObservationIsolationBindingsV2 {
  requestNonce: string;
  requestDigest: string;
  deadlineAt: string;
  containerId: string;
  brokerDigest: string;
  engineDigest: string;
  imageDigest: string;
  producerDigest: string;
  seccompDigest: string;
  createConfigDigest: string;
  limits: AgentOsLocalContainerLimitsV1;
}

export interface AgentOsObservationIsolationPostRunEvidenceV2 {
  requestDigest: string;
  responseDigest: string;
  inspectDigest: string;
  outputEvidenceDigest: string;
  exitEvidenceDigest: string;
  deadlineKillEvidenceDigest: string;
  removalEvidenceDigest: string;
  outputBytes: number;
  outputTruncated: boolean;
  outputLimitExceeded: boolean;
  exitCode: number;
  oomKilled: boolean;
  timedOut: boolean;
  deadlineAt: string;
  deadlineKillObserved: boolean;
  killIssuedAt: string | null;
  finishedAt: string;
  cleanupStartedAt: string;
  removalConfirmed: true;
  containerAbsentAfterRemoval: true;
  removedAt: string;
}

interface AgentOsObservationIsolationAuthorityV2 {
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  containerProvisioningAuthority: false;
  isolationEnforcementAuthority: false;
}

export interface AgentOsObservationIsolationPrepareInputV2
  extends AgentOsObservationIsolationBindingsV2 {
  issuedAt: string;
  expiresAt: string;
}

export interface AgentOsObservationIsolationPrepareAttestationV2
  extends AgentOsObservationIsolationPrepareInputV2, AgentOsObservationIsolationAuthorityV2 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2;
  phase: 'prepared';
  attestationKeyId: string;
  signatureAlgorithm: typeof AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2;
  attestationDigest: string;
  signature: string;
}

export interface AgentOsObservationIsolationFinalizeInputV2
  extends AgentOsObservationIsolationBindingsV2 {
  prepareAttestationDigest: string;
  issuedAt: string;
  expiresAt: string;
  postRun: AgentOsObservationIsolationPostRunEvidenceV2;
}

export interface AgentOsObservationIsolationFinalizeAttestationV2
  extends AgentOsObservationIsolationFinalizeInputV2, AgentOsObservationIsolationAuthorityV2 {
  schemaVersion: 2;
  protocol: typeof AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2;
  phase: 'finalized';
  attestationKeyId: string;
  signatureAlgorithm: typeof AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2;
  attestationDigest: string;
  signature: string;
}

export interface AgentOsObservationIsolationSignerV2 {
  readonly keyId: string;
  sign(canonicalDomainSeparatedAttestation: Uint8Array): Uint8Array | null;
}

export interface AgentOsObservationIsolationVerifierV2 {
  readonly keyId: string;
  verify(input: Readonly<{
    canonicalDomainSeparatedAttestation: Uint8Array;
    signature: Uint8Array;
  }>): boolean;
}

export type AgentOsObservationIsolationReasonV2 =
  | 'attestation-verified'
  | 'invalid-attestation'
  | 'invalid-expected-bindings'
  | 'binding-mismatch'
  | 'policy-binding-mismatch'
  | 'post-run-evidence-mismatch'
  | 'attestation-future'
  | 'attestation-expired'
  | 'attestation-lifetime-invalid'
  | 'attestation-key-mismatch'
  | 'signature-invalid'
  | 'verifier-mutated-input'
  | 'prepare-unverified'
  | 'prepare-link-mismatch'
  | 'phase-time-invalid';

export interface AgentOsObservationIsolationInspectionV2 {
  schemaVersion: 2;
  mode: 'agent-os-observation-isolation-inspection-v2';
  state: 'verified' | 'withheld';
  reason: AgentOsObservationIsolationReasonV2;
  phase: 'prepared' | 'finalized' | null;
  attestationDigest: string | null;
  prepareAttestationDigest: string | null;
  signatureVerified: boolean;
  bindingsVerified: boolean;
  postRunEvidenceVerified: boolean;
  policyBindingsVerified: boolean;
  outputLimitEvidenceVerified: boolean;
  deadlineKillEvidenceVerified: boolean;
  cleanupTimingVerified: boolean;
  removalEvidencePresent: boolean;
  replayConsumptionRequired: true;
  replayConsumptionVerified: false;
  brokerTruthIndependentlyVerified: false;
  dockerEnforcementVerified: false;
  authority: 'observation-only';
  executionAuthority: false;
  effectAuthority: false;
  externalMutationAuthority: false;
  credentialAuthority: false;
  commissioningAuthority: false;
  activationAuthority: false;
  containerProvisioningAuthority: false;
  isolationEnforcementAuthority: false;
}

const AUTHORITY_KEYS = Object.keys(AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2);
const LIMIT_KEYS = [
  'cleanupStartGraceMs', 'cpuNanoCpus', 'maxDurationMs', 'maxOutputBytes', 'memoryBytes',
  'memorySwapBytes', 'pidsLimit',
] as const;
const BINDING_KEYS = [
  'brokerDigest', 'containerId', 'createConfigDigest', 'deadlineAt', 'engineDigest', 'imageDigest',
  'limits', 'producerDigest', 'requestDigest', 'requestNonce', 'seccompDigest',
] as const;
const POST_RUN_KEYS = [
  'cleanupStartedAt', 'containerAbsentAfterRemoval', 'deadlineAt', 'deadlineKillEvidenceDigest',
  'deadlineKillObserved',
  'exitCode', 'exitEvidenceDigest', 'finishedAt', 'inspectDigest', 'killIssuedAt', 'oomKilled',
  'outputBytes', 'outputEvidenceDigest', 'outputLimitExceeded', 'outputTruncated', 'removalConfirmed',
  'removalEvidenceDigest', 'removedAt', 'requestDigest', 'responseDigest', 'timedOut',
] as const;
const PREPARE_INPUT_KEYS = [...BINDING_KEYS, 'expiresAt', 'issuedAt'] as const;
const PREPARE_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, ...PREPARE_INPUT_KEYS, 'attestationKeyId', 'phase', 'protocol',
  'schemaVersion', 'signatureAlgorithm',
] as const;
const PREPARE_KEYS = [...PREPARE_UNSIGNED_KEYS, 'attestationDigest', 'signature'] as const;
const FINALIZE_INPUT_KEYS = [
  ...BINDING_KEYS, 'expiresAt', 'issuedAt', 'postRun', 'prepareAttestationDigest',
] as const;
const FINALIZE_UNSIGNED_KEYS = [
  ...AUTHORITY_KEYS, ...FINALIZE_INPUT_KEYS, 'attestationKeyId', 'phase', 'protocol',
  'schemaVersion', 'signatureAlgorithm',
] as const;
const FINALIZE_KEYS = [...FINALIZE_UNSIGNED_KEYS, 'attestationDigest', 'signature'] as const;

function owned<T>(value: T): T | null {
  try { return deepFreeze(JSON.parse(canonicalJson(value)) as T); } catch { return null; }
}

function bindings(value: unknown): value is AgentOsObservationIsolationBindingsV2 {
  const row = record(value);
  if (!row || !exactKeys(row, BINDING_KEYS) ||
    decodeEpochBase64url(row['requestNonce'], 16, 64) === null ||
    !rawDigest(row['requestDigest']) || !timestamp(row['deadlineAt']) ||
    !rawDigest(row['containerId']) || !isAgentOsLocalContainerLimitsV1(row['limits'])) return false;
  return ['brokerDigest', 'engineDigest', 'imageDigest', 'producerDigest', 'seccompDigest',
    'createConfigDigest'].every((key) => rawDigest(row[key]));
}

function bindingsEqual(
  left: AgentOsObservationIsolationBindingsV2,
  right: AgentOsObservationIsolationBindingsV2,
): boolean {
  return BINDING_KEYS.every((key) => key === 'limits'
    ? LIMIT_KEYS.every((limit) => left.limits[limit] === right.limits[limit])
    : left[key] === right[key]);
}

function postRun(value: unknown): value is AgentOsObservationIsolationPostRunEvidenceV2 {
  const row = record(value);
  if (!row || !exactKeys(row, POST_RUN_KEYS) || !rawDigest(row['requestDigest']) ||
    !rawDigest(row['responseDigest']) || !rawDigest(row['inspectDigest']) ||
    !rawDigest(row['outputEvidenceDigest']) || !rawDigest(row['exitEvidenceDigest']) ||
    !rawDigest(row['deadlineKillEvidenceDigest']) || !rawDigest(row['removalEvidenceDigest']) ||
    !Number.isSafeInteger(row['outputBytes']) || (row['outputBytes'] as number) < 0 ||
    typeof row['outputTruncated'] !== 'boolean' || typeof row['outputLimitExceeded'] !== 'boolean' ||
    !Number.isSafeInteger(row['exitCode']) || (row['exitCode'] as number) < 0 ||
    (row['exitCode'] as number) > 255 || typeof row['oomKilled'] !== 'boolean' ||
    typeof row['timedOut'] !== 'boolean' || !timestamp(row['deadlineAt']) ||
    typeof row['deadlineKillObserved'] !== 'boolean' ||
    (row['killIssuedAt'] !== null && !timestamp(row['killIssuedAt'])) ||
    !timestamp(row['finishedAt']) || !timestamp(row['cleanupStartedAt']) ||
    row['removalConfirmed'] !== true || row['containerAbsentAfterRemoval'] !== true ||
    !timestamp(row['removedAt'])) return false;
  return Date.parse(row['cleanupStartedAt']) >= Date.parse(row['finishedAt']) &&
    Date.parse(row['removedAt']) >= Date.parse(row['cleanupStartedAt']);
}

function postRunCoherent(
  evidence: AgentOsObservationIsolationPostRunEvidenceV2,
  expected: AgentOsObservationIsolationBindingsV2,
): boolean {
  if (evidence.requestDigest !== expected.requestDigest || evidence.deadlineAt !== expected.deadlineAt ||
    evidence.outputBytes > expected.limits.maxOutputBytes ||
    evidence.outputTruncated !== evidence.outputLimitExceeded ||
    (evidence.outputLimitExceeded && evidence.outputBytes !== expected.limits.maxOutputBytes)) return false;
  const deadline = Date.parse(expected.deadlineAt);
  const finished = Date.parse(evidence.finishedAt);
  if (evidence.timedOut) {
    if (!evidence.deadlineKillObserved || evidence.killIssuedAt === null) return false;
    const killed = Date.parse(evidence.killIssuedAt);
    if (killed < deadline || killed - deadline >
      AGENT_OS_OBSERVATION_ISOLATION_MAX_DEADLINE_KILL_LAG_MS_V2 || finished < killed ||
      finished - killed > AGENT_OS_OBSERVATION_ISOLATION_MAX_DEADLINE_KILL_LAG_MS_V2) return false;
  } else if (evidence.deadlineKillObserved || evidence.killIssuedAt !== null || finished > deadline) {
    return false;
  }
  const cleanupStarted = Date.parse(evidence.cleanupStartedAt);
  const removed = Date.parse(evidence.removedAt);
  return cleanupStarted - finished <= expected.limits.cleanupStartGraceMs &&
    removed - cleanupStarted <= AGENT_OS_OBSERVATION_ISOLATION_MAX_CLEANUP_DURATION_MS_V2;
}

function policyBindingsMatch(
  expected: AgentOsObservationIsolationBindingsV2,
  value: unknown,
): boolean {
  const inspection = inspectAgentOsLocalContainerCreatePolicyV1(value);
  const policy = inspection.policy;
  if (!policy || !inspection.createConfigDigest) return false;
  const imageDigest = policy.image.slice(policy.image.indexOf('@sha256:') + '@sha256:'.length);
  return expected.imageDigest === imageDigest &&
    expected.seccompDigest === policy.seccompProfileDigest &&
    expected.producerDigest === policy.producer.digest &&
    expected.createConfigDigest === inspection.createConfigDigest &&
    LIMIT_KEYS.every((key) => expected.limits[key] === policy.limits[key]);
}

function postRunEqual(
  left: AgentOsObservationIsolationPostRunEvidenceV2,
  right: AgentOsObservationIsolationPostRunEvidenceV2,
): boolean {
  return POST_RUN_KEYS.every((key) => left[key] === right[key]);
}

function validSigner(value: unknown): value is AgentOsObservationIsolationSignerV2 {
  const signer = record(value);
  return Boolean(signer && exactKeys(signer, ['keyId', 'sign']) && rawDigest(signer['keyId']) &&
    typeof signer['sign'] === 'function');
}

function validVerifier(value: unknown): value is AgentOsObservationIsolationVerifierV2 {
  const verifier = record(value);
  return Boolean(verifier && exactKeys(verifier, ['keyId', 'verify']) && rawDigest(verifier['keyId']) &&
    typeof verifier['verify'] === 'function');
}

function pinVerifier(value: unknown): AgentOsObservationIsolationVerifierV2 | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!exactKeys(descriptors, ['keyId', 'verify'])) return null;
    const keyId = descriptors['keyId'];
    const verify = descriptors['verify'];
    if (!keyId || !verify || !Object.hasOwn(keyId, 'value') || !Object.hasOwn(verify, 'value') ||
      !rawDigest(keyId.value) || typeof verify.value !== 'function') return null;
    return Object.freeze({ keyId: keyId.value, verify: verify.value });
  } catch {
    return null;
  }
}

function validPrepareInput(value: unknown): value is AgentOsObservationIsolationPrepareInputV2 {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_INPUT_KEYS) || !timestamp(row['issuedAt']) ||
    !timestamp(row['expiresAt'])) return false;
  const selected = Object.fromEntries(BINDING_KEYS.map((key) => [key, row[key]]));
  const lifetime = Date.parse(row['expiresAt']) - Date.parse(row['issuedAt']);
  if (!bindings(selected)) return false;
  const issued = Date.parse(row['issuedAt']);
  const deadline = Date.parse(selected.deadlineAt);
  return lifetime > 0 && lifetime <= AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2 &&
    deadline > issued && deadline - issued <= selected.limits.maxDurationMs &&
    deadline < Date.parse(row['expiresAt']);
}

function validFinalizeInput(value: unknown): value is AgentOsObservationIsolationFinalizeInputV2 {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_INPUT_KEYS) || !rawDigest(row['prepareAttestationDigest']) ||
    !timestamp(row['issuedAt']) || !timestamp(row['expiresAt']) || !postRun(row['postRun'])) return false;
  const selected = Object.fromEntries(BINDING_KEYS.map((key) => [key, row[key]]));
  const lifetime = Date.parse(row['expiresAt']) - Date.parse(row['issuedAt']);
  return bindings(selected) && postRunCoherent(row['postRun'], selected) &&
    lifetime > 0 && lifetime <= AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2 &&
    Date.parse(row['postRun'].removedAt) <= Date.parse(row['issuedAt']);
}

type PrepareUnsigned = Omit<AgentOsObservationIsolationPrepareAttestationV2,
'attestationDigest' | 'signature'>;
type FinalizeUnsigned = Omit<AgentOsObservationIsolationFinalizeAttestationV2,
'attestationDigest' | 'signature'>;

function validPrepareUnsigned(value: unknown): value is PrepareUnsigned {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_UNSIGNED_KEYS) || row['schemaVersion'] !== 2 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 || row['phase'] !== 'prepared' ||
    !matchesEpochAuthority(row, AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2) ||
    !rawDigest(row['attestationKeyId']) ||
    row['signatureAlgorithm'] !== AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2) return false;
  const selected = Object.fromEntries(PREPARE_INPUT_KEYS.map((key) => [key, row[key]]));
  return validPrepareInput(selected);
}

function validFinalizeUnsigned(value: unknown): value is FinalizeUnsigned {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_UNSIGNED_KEYS) || row['schemaVersion'] !== 2 ||
    row['protocol'] !== AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2 || row['phase'] !== 'finalized' ||
    !matchesEpochAuthority(row, AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2) ||
    !rawDigest(row['attestationKeyId']) ||
    row['signatureAlgorithm'] !== AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2) return false;
  const selected = Object.fromEntries(FINALIZE_INPUT_KEYS.map((key) => [key, row[key]]));
  return validFinalizeInput(selected);
}

function validPrepare(value: unknown): value is AgentOsObservationIsolationPrepareAttestationV2 {
  const row = record(value);
  if (!row || !exactKeys(row, PREPARE_KEYS) || !rawDigest(row['attestationDigest']) ||
    decodeEpochBase64url(row['signature'], 64, 64) === null) return false;
  const unsigned = Object.fromEntries(PREPARE_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  return validPrepareUnsigned(unsigned) &&
    digest(PREPARE_DIGEST_DOMAIN, unsigned) === row['attestationDigest'];
}

function validFinalize(value: unknown): value is AgentOsObservationIsolationFinalizeAttestationV2 {
  const row = record(value);
  if (!row || !exactKeys(row, FINALIZE_KEYS) || !rawDigest(row['attestationDigest']) ||
    decodeEpochBase64url(row['signature'], 64, 64) === null) return false;
  const unsigned = Object.fromEntries(FINALIZE_UNSIGNED_KEYS.map((key) => [key, row[key]]));
  return validFinalizeUnsigned(unsigned) &&
    digest(FINALIZE_DIGEST_DOMAIN, unsigned) === row['attestationDigest'];
}

function canonicalPreparePayload(value: unknown): Buffer | null {
  return validPrepareUnsigned(value) ? domainBytes(PREPARE_SIGNATURE_DOMAIN, value) : null;
}

function canonicalFinalizePayload(value: unknown): Buffer | null {
  return validFinalizeUnsigned(value) ? domainBytes(FINALIZE_SIGNATURE_DOMAIN, value) : null;
}

function signUnsigned<T extends PrepareUnsigned | FinalizeUnsigned>(
  unsigned: T,
  signer: AgentOsObservationIsolationSignerV2,
  phase: 'prepared' | 'finalized',
): (T & { attestationDigest: string; signature: string }) | null {
  const payload = phase === 'prepared'
    ? canonicalPreparePayload(unsigned)
    : canonicalFinalizePayload(unsigned);
  if (!payload) return null;
  const callbackBytes = Buffer.from(payload);
  const before = Buffer.from(callbackBytes);
  try {
    const signature = signer.sign(callbackBytes);
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64 ||
      !exactBytes(callbackBytes, before)) return null;
    const attestationDigest = digest(
      phase === 'prepared' ? PREPARE_DIGEST_DOMAIN : FINALIZE_DIGEST_DOMAIN,
      unsigned,
    );
    return {
      ...unsigned,
      attestationDigest,
      signature: Buffer.from(signature).toString('base64url'),
    };
  } catch {
    return null;
  }
}

export function createAgentOsObservationIsolationPrepareAttestationV2(
  input: unknown,
  signer: AgentOsObservationIsolationSignerV2,
): AgentOsObservationIsolationPrepareAttestationV2 | null {
  try {
    if (!validPrepareInput(input) || !validSigner(signer)) return null;
    const ownedInput = owned(input);
    if (!ownedInput) return null;
    const unsigned: PrepareUnsigned = {
      schemaVersion: 2,
      protocol: AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2,
      phase: 'prepared',
      ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
      ...ownedInput,
      attestationKeyId: signer.keyId,
      signatureAlgorithm: AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2,
    };
    const signed = signUnsigned(unsigned, signer, 'prepared');
    return signed && validPrepare(signed) ? owned(signed) : null;
  } catch {
    return null;
  }
}

export function createAgentOsObservationIsolationFinalizeAttestationV2(
  input: unknown,
  signer: AgentOsObservationIsolationSignerV2,
): AgentOsObservationIsolationFinalizeAttestationV2 | null {
  try {
    if (!validFinalizeInput(input) || !validSigner(signer)) return null;
    const ownedInput = owned(input);
    if (!ownedInput) return null;
    const unsigned: FinalizeUnsigned = {
      schemaVersion: 2,
      protocol: AGENT_OS_OBSERVATION_ISOLATION_PROTOCOL_V2,
      phase: 'finalized',
      ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
      ...ownedInput,
      attestationKeyId: signer.keyId,
      signatureAlgorithm: AGENT_OS_OBSERVATION_ISOLATION_SIGNATURE_ALGORITHM_V2,
    };
    const signed = signUnsigned(unsigned, signer, 'finalized');
    return signed && validFinalize(signed) ? owned(signed) : null;
  } catch {
    return null;
  }
}

function withheld(
  reason: Exclude<AgentOsObservationIsolationReasonV2, 'attestation-verified'>,
  phase: 'prepared' | 'finalized' | null = null,
  prepareAttestationDigest: string | null = null,
): AgentOsObservationIsolationInspectionV2 {
  return Object.freeze({
    schemaVersion: 2,
    mode: 'agent-os-observation-isolation-inspection-v2',
    state: 'withheld',
    reason,
    phase,
    attestationDigest: null,
    prepareAttestationDigest,
    signatureVerified: false,
    bindingsVerified: false,
    postRunEvidenceVerified: false,
    policyBindingsVerified: false,
    outputLimitEvidenceVerified: false,
    deadlineKillEvidenceVerified: false,
    cleanupTimingVerified: false,
    removalEvidencePresent: false,
    replayConsumptionRequired: true,
    replayConsumptionVerified: false,
    brokerTruthIndependentlyVerified: false,
    dockerEnforcementVerified: false,
    ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
  });
}

function timeReason(
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
): 'attestation-future' | 'attestation-expired' | 'attestation-lifetime-invalid' | null {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (issued > nowMs + AGENT_OS_OBSERVATION_ISOLATION_MAX_FUTURE_SKEW_MS_V2) {
    return 'attestation-future';
  }
  if (expires <= nowMs) return 'attestation-expired';
  return expires <= issued ||
    expires - issued > AGENT_OS_OBSERVATION_ISOLATION_MAX_ATTESTATION_LIFETIME_MS_V2
    ? 'attestation-lifetime-invalid' : null;
}

function verifySignature(
  unsigned: PrepareUnsigned | FinalizeUnsigned,
  signature: string,
  verifier: AgentOsObservationIsolationVerifierV2,
  phase: 'prepared' | 'finalized',
): 'verified' | 'attestation-key-mismatch' | 'signature-invalid' | 'verifier-mutated-input' {
  if (!validVerifier(verifier) || unsigned.attestationKeyId !== verifier.keyId) {
    return 'attestation-key-mismatch';
  }
  const payload = phase === 'prepared'
    ? canonicalPreparePayload(unsigned)
    : canonicalFinalizePayload(unsigned);
  const signatureBytes = decodeEpochBase64url(signature, 64, 64);
  if (!payload || !signatureBytes) return 'signature-invalid';
  const callbackBytes = Buffer.from(payload);
  const before = Buffer.from(callbackBytes);
  const callbackSignature = Buffer.from(signatureBytes);
  const signatureBefore = Buffer.from(callbackSignature);
  let verified = false;
  try {
    verified = verifier.verify(deepFreeze({
      canonicalDomainSeparatedAttestation: callbackBytes,
      signature: callbackSignature,
    })) === true;
  } catch {
    verified = false;
  }
  if (!exactBytes(callbackBytes, before) || !exactBytes(callbackSignature, signatureBefore)) {
    return 'verifier-mutated-input';
  }
  return verified ? 'verified' : 'signature-invalid';
}

function verified(
  phase: 'prepared' | 'finalized',
  attestationDigest: string,
  prepareAttestationDigest: string | null,
): AgentOsObservationIsolationInspectionV2 {
  return Object.freeze({
    schemaVersion: 2,
    mode: 'agent-os-observation-isolation-inspection-v2',
    state: 'verified',
    reason: 'attestation-verified',
    phase,
    attestationDigest,
    prepareAttestationDigest,
    signatureVerified: true,
    bindingsVerified: true,
    postRunEvidenceVerified: phase === 'finalized',
    policyBindingsVerified: true,
    outputLimitEvidenceVerified: phase === 'finalized',
    deadlineKillEvidenceVerified: phase === 'finalized',
    cleanupTimingVerified: phase === 'finalized',
    removalEvidencePresent: phase === 'finalized',
    replayConsumptionRequired: true,
    replayConsumptionVerified: false,
    brokerTruthIndependentlyVerified: false,
    dockerEnforcementVerified: false,
    ...AGENT_OS_OBSERVATION_ISOLATION_NO_AUTHORITY_V2,
  });
}

export function verifyAgentOsObservationIsolationPrepareAttestationV2(
  value: unknown,
  expectedBindings: unknown,
  expectedPolicy: unknown,
  verifier: AgentOsObservationIsolationVerifierV2,
  nowMs: number,
): AgentOsObservationIsolationInspectionV2 {
  const snapshot = immutableDataSnapshot({ value, expectedBindings, expectedPolicy, nowMs });
  if (!snapshot || !validPrepare(snapshot.value)) return withheld('invalid-attestation', 'prepared');
  const attestation = snapshot.value;
  const pinnedVerifier = pinVerifier(verifier);
  if (!pinnedVerifier) return withheld('attestation-key-mismatch', 'prepared');
  if (!bindings(snapshot.expectedBindings) || !Number.isSafeInteger(snapshot.nowMs) ||
    snapshot.nowMs < 0) {
    return withheld('invalid-expected-bindings', 'prepared');
  }
  if (!bindingsEqual(attestation, snapshot.expectedBindings)) {
    return withheld('binding-mismatch', 'prepared');
  }
  if (!policyBindingsMatch(snapshot.expectedBindings, snapshot.expectedPolicy)) {
    return withheld('policy-binding-mismatch', 'prepared');
  }
  const timing = timeReason(attestation.issuedAt, attestation.expiresAt, snapshot.nowMs);
  if (timing) return withheld(timing, 'prepared');
  const row = attestation as unknown as Record<string, unknown>;
  const unsigned = Object.fromEntries(PREPARE_UNSIGNED_KEYS.map((key) => [key, row[key]])) as PrepareUnsigned;
  const signatureState = verifySignature(unsigned, attestation.signature, pinnedVerifier, 'prepared');
  if (signatureState !== 'verified') return withheld(signatureState, 'prepared');
  return verified('prepared', attestation.attestationDigest, null);
}

export function verifyAgentOsObservationIsolationFinalizeAttestationV2(
  value: unknown,
  prepare: unknown,
  expectedBindings: unknown,
  expectedPolicy: unknown,
  expectedPostRun: unknown,
  verifier: AgentOsObservationIsolationVerifierV2,
  nowMs: number,
): AgentOsObservationIsolationInspectionV2 {
  const snapshot = immutableDataSnapshot({
    value, prepare, expectedBindings, expectedPolicy, expectedPostRun, nowMs,
  });
  if (!snapshot || !validFinalize(snapshot.value)) return withheld('invalid-attestation', 'finalized');
  const attestation = snapshot.value;
  const pinnedVerifier = pinVerifier(verifier);
  if (!pinnedVerifier) {
    return withheld('attestation-key-mismatch', 'finalized', attestation.prepareAttestationDigest);
  }
  if (!bindings(snapshot.expectedBindings) || !postRun(snapshot.expectedPostRun) ||
    !Number.isSafeInteger(snapshot.nowMs) || snapshot.nowMs < 0) {
    return withheld('invalid-expected-bindings', 'finalized');
  }
  if (!validPrepare(snapshot.prepare)) {
    return withheld('prepare-unverified', 'finalized', attestation.prepareAttestationDigest);
  }
  const prepared = snapshot.prepare;
  const prepareInspection = verifyAgentOsObservationIsolationPrepareAttestationV2(
    prepared,
    snapshot.expectedBindings,
    snapshot.expectedPolicy,
    pinnedVerifier,
    snapshot.nowMs,
  );
  if (prepareInspection.state !== 'verified') {
    return withheld('prepare-unverified', 'finalized', attestation.prepareAttestationDigest);
  }
  if (attestation.prepareAttestationDigest !== prepared.attestationDigest) {
    return withheld('prepare-link-mismatch', 'finalized', attestation.prepareAttestationDigest);
  }
  if (!bindingsEqual(attestation, snapshot.expectedBindings)) {
    return withheld('binding-mismatch', 'finalized', attestation.prepareAttestationDigest);
  }
  if (!policyBindingsMatch(snapshot.expectedBindings, snapshot.expectedPolicy)) {
    return withheld('policy-binding-mismatch', 'finalized', attestation.prepareAttestationDigest);
  }
  if (!postRunEqual(attestation.postRun, snapshot.expectedPostRun) ||
    !postRunCoherent(snapshot.expectedPostRun, snapshot.expectedBindings)) {
    return withheld('post-run-evidence-mismatch', 'finalized', attestation.prepareAttestationDigest);
  }
  const timing = timeReason(attestation.issuedAt, attestation.expiresAt, snapshot.nowMs);
  if (timing) return withheld(timing, 'finalized', attestation.prepareAttestationDigest);
  if (Date.parse(attestation.issuedAt) < Date.parse(prepared.issuedAt) ||
    Date.parse(attestation.issuedAt) > Date.parse(prepared.expiresAt) ||
    Date.parse(attestation.postRun.finishedAt) < Date.parse(prepared.issuedAt) ||
    Date.parse(attestation.postRun.finishedAt) - Date.parse(prepared.issuedAt) >
      attestation.limits.maxDurationMs) {
    return withheld('phase-time-invalid', 'finalized', attestation.prepareAttestationDigest);
  }
  const row = attestation as unknown as Record<string, unknown>;
  const unsigned = Object.fromEntries(FINALIZE_UNSIGNED_KEYS.map((key) => [key, row[key]])) as FinalizeUnsigned;
  const signatureState = verifySignature(unsigned, attestation.signature, pinnedVerifier, 'finalized');
  if (signatureState !== 'verified') {
    return withheld(signatureState, 'finalized', attestation.prepareAttestationDigest);
  }
  return verified('finalized', attestation.attestationDigest, attestation.prepareAttestationDigest);
}
