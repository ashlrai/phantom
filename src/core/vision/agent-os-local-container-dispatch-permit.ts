import {
  canonicalEpochDomainBytes,
  canonicalEpochJsonDigest,
  decodeEpochBase64url,
  exactOwnDataKeys as exactKeys,
  immutablePlainDataSnapshot,
  isValidEpochTimestamp as timestamp,
  isValidPrefixedEpochDigest,
  isValidRawEpochDigest,
  nonProxyPlainRecord as record,
} from './agent-os-epoch-shared.js';

export const AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1 =
  'ashlr-agent-os-local-container-dispatch-permit-v1' as const;
export const AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1 = 'ed25519' as const;
const AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_MAX_LIFETIME_MS_V1 = 5 * 60_000;
const AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_MAX_FUTURE_SKEW_MS_V1 = 5_000;

const SIGNATURE_DOMAIN = 'ashlr:agent-os:local-container-dispatch-permit:signature:v1\0';
const DIGEST_DOMAIN = 'ashlr:agent-os:local-container-dispatch-permit:digest:v1\0';
const PERMIT_GRAPH_OPTIONS = Object.freeze({ maxDepth: 8, maxNodes: 64, allowArrays: false });

export const AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1 = Object.freeze({
  action: 'agent-os-observation-container-once' as const,
  once: true as const,
  localOnly: true as const,
  observationOnly: true as const,
  providerContact: false as const,
  credentialAccess: false as const,
  hostFilesystemWrite: false as const,
  externalMutation: false as const,
});

export const AGENT_OS_LOCAL_CONTAINER_DISPATCH_RESULT_NO_AUTHORITY_V1 = Object.freeze({
  authority: 'verification-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  providerContactAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
});

export interface AgentOsLocalContainerDispatchPermitBindingsV1 {
  requestNonce: string;
  requestDigest: string;
  deadlineAt: string;
  brokerDigest: string;
  engineDigest: string;
  imageDigest: string;
  producerDigest: string;
  seccompDigest: string;
  createConfigDigest: string;
  executionIdentityDigest: string;
  capacityEvidenceDigest: string;
  slots: 1;
}

export interface AgentOsLocalContainerDispatchPermitUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1;
  permitId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: typeof AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1;
  bindings: AgentOsLocalContainerDispatchPermitBindingsV1;
}

export interface AgentOsLocalContainerDispatchPermitEnvelopeV1
  extends AgentOsLocalContainerDispatchPermitUnsignedV1 {
  signatureAlgorithm: typeof AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1;
  permitDigest: string;
  signature: string;
}

export interface AgentOsLocalContainerDispatchPermitVerifierV1 {
  readonly keyId: string;
  verify(input: Readonly<{
    canonicalDomainSeparatedPermit: Uint8Array;
    signature: Uint8Array;
  }>): boolean;
}

export type AgentOsLocalContainerDispatchPermitReasonV1 =
  | 'permit-verified'
  | 'invalid-input'
  | 'invalid-permit'
  | 'binding-mismatch'
  | 'permit-future'
  | 'permit-expired'
  | 'permit-lifetime-invalid'
  | 'permit-key-mismatch'
  | 'signature-invalid'
  | 'verifier-mutated-input';

export interface AgentOsLocalContainerDispatchPermitInspectionV1
  extends Readonly<typeof AGENT_OS_LOCAL_CONTAINER_DISPATCH_RESULT_NO_AUTHORITY_V1> {
  state: 'verified' | 'withheld';
  reason: AgentOsLocalContainerDispatchPermitReasonV1;
  dispatchAuthorized: boolean;
  permitDigest: string | null;
  keyId: string | null;
  requestDigest: string | null;
}

const SCOPE_KEYS = [
  'action', 'credentialAccess', 'externalMutation', 'hostFilesystemWrite', 'localOnly',
  'observationOnly', 'once', 'providerContact',
] as const;
const BINDING_KEYS = [
  'brokerDigest', 'capacityEvidenceDigest', 'createConfigDigest', 'deadlineAt', 'engineDigest',
  'executionIdentityDigest', 'imageDigest', 'producerDigest', 'requestDigest', 'requestNonce',
  'seccompDigest', 'slots',
] as const;
const UNSIGNED_KEYS = [
  'bindings', 'expiresAt', 'issuedAt', 'keyId', 'permitId', 'protocol', 'schemaVersion', 'scope',
] as const;
const ENVELOPE_KEYS = [
  ...UNSIGNED_KEYS, 'permitDigest', 'signature', 'signatureAlgorithm',
] as const;

function scope(value: unknown): boolean {
  const row = record(value);
  return Boolean(row && exactKeys(row, SCOPE_KEYS) && SCOPE_KEYS.every((key) =>
    row[key] === AGENT_OS_LOCAL_CONTAINER_DISPATCH_SCOPE_V1[key]));
}

function bindings(value: unknown): value is AgentOsLocalContainerDispatchPermitBindingsV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, BINDING_KEYS) &&
    decodeEpochBase64url(row['requestNonce'], 16, 64) !== null &&
    timestamp(row['deadlineAt']) && row['slots'] === 1 &&
    ['requestDigest', 'brokerDigest', 'engineDigest', 'imageDigest', 'producerDigest', 'seccompDigest',
      'createConfigDigest'].every((key) => isValidRawEpochDigest(row[key])) &&
    isValidPrefixedEpochDigest(row['executionIdentityDigest']) &&
    isValidPrefixedEpochDigest(row['capacityEvidenceDigest']));
}

function unsigned(value: unknown): AgentOsLocalContainerDispatchPermitUnsignedV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, UNSIGNED_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_V1 ||
    !isValidRawEpochDigest(row['permitId']) ||
    !isValidRawEpochDigest(row['keyId']) ||
    !timestamp(row['issuedAt']) || !timestamp(row['expiresAt']) || !scope(row['scope']) ||
    !bindings(row['bindings'])) return null;
  return row as unknown as AgentOsLocalContainerDispatchPermitUnsignedV1;
}

function envelope(value: unknown): AgentOsLocalContainerDispatchPermitEnvelopeV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, ENVELOPE_KEYS) ||
    row['signatureAlgorithm'] !== AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_SIGNATURE_ALGORITHM_V1 ||
    !isValidRawEpochDigest(row['permitDigest']) ||
    decodeEpochBase64url(row['signature'], 64, 64) === null) return null;
  const selected = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, row[key]]));
  const parsed = unsigned(selected);
  if (!parsed || canonicalEpochJsonDigest(DIGEST_DOMAIN, parsed) !== row['permitDigest']) return null;
  return row as unknown as AgentOsLocalContainerDispatchPermitEnvelopeV1;
}

function bindingsEqual(
  left: AgentOsLocalContainerDispatchPermitBindingsV1,
  right: AgentOsLocalContainerDispatchPermitBindingsV1,
): boolean {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

function inspection(
  state: AgentOsLocalContainerDispatchPermitInspectionV1['state'],
  reason: AgentOsLocalContainerDispatchPermitReasonV1,
  values: Partial<Pick<AgentOsLocalContainerDispatchPermitInspectionV1,
  'permitDigest' | 'keyId' | 'requestDigest'>> = {},
): AgentOsLocalContainerDispatchPermitInspectionV1 {
  return Object.freeze({
    state,
    reason,
    dispatchAuthorized: state === 'verified',
    permitDigest: values.permitDigest ?? null,
    keyId: values.keyId ?? null,
    requestDigest: values.requestDigest ?? null,
    ...AGENT_OS_LOCAL_CONTAINER_DISPATCH_RESULT_NO_AUTHORITY_V1,
  });
}

export function canonicalAgentOsLocalContainerDispatchPermitBytesV1(
  value: unknown,
): Buffer | null {
  const snapshot = immutablePlainDataSnapshot(value, PERMIT_GRAPH_OPTIONS);
  const parsed = unsigned(snapshot);
  return parsed ? canonicalEpochDomainBytes(SIGNATURE_DOMAIN, parsed) : null;
}

export function digestAgentOsLocalContainerDispatchPermitV1(value: unknown): string | null {
  const snapshot = immutablePlainDataSnapshot(value, PERMIT_GRAPH_OPTIONS);
  const parsed = unsigned(snapshot);
  return parsed ? canonicalEpochJsonDigest(DIGEST_DOMAIN, parsed) : null;
}

export function verifyAgentOsLocalContainerDispatchPermitV1(
  value: unknown,
  expectedBindings: AgentOsLocalContainerDispatchPermitBindingsV1,
  verifier: AgentOsLocalContainerDispatchPermitVerifierV1,
  nowMs: number,
): AgentOsLocalContainerDispatchPermitInspectionV1 {
  const ownedValue = immutablePlainDataSnapshot(value, PERMIT_GRAPH_OPTIONS);
  const ownedBindings = immutablePlainDataSnapshot(expectedBindings, PERMIT_GRAPH_OPTIONS);
  if (!ownedValue || !ownedBindings || !bindings(ownedBindings) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) return inspection('withheld', 'invalid-input');
  const parsed = envelope(ownedValue);
  if (!parsed) return inspection('withheld', 'invalid-permit');
  const verifierRow = record(verifier);
  if (!verifierRow || !exactKeys(verifierRow, ['keyId', 'verify']) ||
    !isValidRawEpochDigest(verifierRow['keyId']) ||
    typeof verifierRow['verify'] !== 'function' || parsed.keyId !== verifierRow['keyId']) {
    return inspection('withheld', 'permit-key-mismatch', {
      permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
    });
  }
  if (!bindingsEqual(parsed.bindings, ownedBindings)) return inspection('withheld', 'binding-mismatch', {
    permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
  });
  const issued = Date.parse(parsed.issuedAt);
  const expires = Date.parse(parsed.expiresAt);
  if (expires <= issued || expires - issued > AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_MAX_LIFETIME_MS_V1 ||
    Date.parse(parsed.bindings.deadlineAt) > expires) {
    return inspection('withheld', 'permit-lifetime-invalid', {
      permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
    });
  }
  if (issued > nowMs + AGENT_OS_LOCAL_CONTAINER_DISPATCH_PERMIT_MAX_FUTURE_SKEW_MS_V1) {
    return inspection('withheld', 'permit-future', {
      permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
    });
  }
  if (expires <= nowMs) return inspection('withheld', 'permit-expired', {
    permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
  });
  const parsedUnsigned = Object.fromEntries(UNSIGNED_KEYS.map((key) => [key, parsed[key]]));
  const bytes = canonicalEpochDomainBytes(SIGNATURE_DOMAIN, parsedUnsigned);
  const callbackBytes = Buffer.from(bytes);
  const signature = Buffer.from(parsed.signature, 'base64url');
  let verified = false;
  try {
    verified = (verifierRow['verify'] as AgentOsLocalContainerDispatchPermitVerifierV1['verify'])(
      Object.freeze({ canonicalDomainSeparatedPermit: callbackBytes, signature: Buffer.from(signature) }),
    ) === true;
  } catch {
    verified = false;
  }
  if (!bytes.equals(callbackBytes)) return inspection('withheld', 'verifier-mutated-input', {
    permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
  });
  return inspection(verified ? 'verified' : 'withheld', verified ? 'permit-verified' : 'signature-invalid', {
    permitDigest: parsed.permitDigest, keyId: parsed.keyId, requestDigest: parsed.bindings.requestDigest,
  });
}
