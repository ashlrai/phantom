/**
 * M568 version-general stopped-selection permit protocol.
 *
 * This module is deliberately pure. It authenticates canonical intent and
 * exact release bindings, but it cannot consume replay state, mutate a pointer
 * or plist, contact launchd, or grant selection/rollback authority. Those
 * effects require a separately installed protected native broker.
 */

import { sign, type KeyObject } from 'node:crypto';
import { posix } from 'node:path';

import { canonicalizeDaemonActivationValue } from './activation-permit.js';
import {
  RUNTIME_SHA256_RE as SHA256_RE,
  canonicalValuesEqual,
  decodeCanonicalBase64url as canonicalBase64url,
  decodeCanonicalJsonFrame,
  isCanonicalTimestamp as canonicalTimestamp,
  runtimePermitKeyId,
  sha256Hex as sha256,
  strictDataRecord as dataRecord,
  verifyEd25519RuntimePermit,
} from './runtime-protocol-shared.js';

export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL =
  'runtime-activation-stopped-consumer-v2' as const;
export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN =
  'ashlr:runtime-activation-stopped-consumer:permit:v2' as const;

const PERMIT_SIGNATURE_DOMAIN = `${RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN}\0`;
const MAX_PERMIT_FRAME_BYTES = 64 * 1024;
const MAX_PERMIT_VALIDITY_MS = 120_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_PATH_BYTES = 2_048;
const SHA1_RE = /^[a-f0-9]{40}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PACKAGE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export const RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY = Object.freeze({
  activationPermitted: false,
  deployPermitted: false,
  dispatchPermitted: false,
  effectPermitted: false,
  installPermitted: false,
  launchPermitted: false,
  pointerMutationPermitted: false,
  rollbackPermitted: false,
  selectionPermitted: false,
  serviceMutationPermitted: false,
  startPermitted: false,
} as const);

export interface RuntimeActivationStoppedConsumerV2TrustRoot {
  algorithm: 'ed25519';
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeActivationStoppedConsumerV2Bindings {
  activationId: string;
  admissionDigest: string;
  planDigest: string;
  canonicalRequestSha256: string;
  trustRootCanonicalSha256: string;
  configSha256: string;
  homePath: string;
  releasesRoot: string;
  currentPointerPath: string;
  plistPath: string;
  candidateRevision: string;
  candidateExpectedTree: string;
  candidateVersion: string;
  candidateReleaseTag: string;
  candidateRuntimeTreeSha256: string;
  candidateManifestDigest: string;
  candidateLaunchReceiptSha256: string;
  candidateServiceDescriptorSha256: string;
  candidateServiceInvocationDigest: string;
  candidateCurrentTarget: string;
  rollbackRevision: string;
  rollbackExpectedTree: string;
  rollbackVersion: string;
  rollbackReleaseTag: string;
  rollbackRuntimeTreeSha256: string;
  rollbackManifestDigest: string;
  rollbackLaunchReceiptSha256: string;
  rollbackServiceDescriptorSha256: string;
  rollbackServiceInvocationDigest: string;
  priorCurrentTarget: string;
  priorPlistSha256: string;
  priorServiceLoaded: false;
  priorServiceDisabled: boolean;
  hostUid: number;
  serviceLabel: 'ai.ashlr.daemon';
  serviceTarget: string;
}

export interface RuntimeActivationStoppedConsumerV2PermitPayload {
  schemaVersion: 2;
  protocol: typeof RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL;
  permitId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  scope: {
    action: 'select-exact-admitted-stopped-release';
    platform: 'darwin';
    nativeBrokerRequired: true;
    nativeConditionalCasRequired: true;
    maintenance: true;
    killSwitch: 'healthy-engaged';
    providerEffectsBlocked: true;
    serviceLoaded: false;
    serviceStart: false;
    serviceEnable: false;
    serviceInstall: false;
    pointerSelectionRequested: true;
    exactStoppedRollbackRequired: true;
    residentAcknowledgement: false;
    dispatchAuthorized: false;
  };
  bindings: RuntimeActivationStoppedConsumerV2Bindings;
}

export interface RuntimeActivationStoppedConsumerV2PermitEnvelope {
  payload: RuntimeActivationStoppedConsumerV2PermitPayload;
  signature: string;
}

export interface RuntimeActivationStoppedConsumerV2EvidenceResult {
  ok: boolean;
  reason: string;
  authority: typeof RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY;
  permitDigest: string | null;
}

const BINDING_KEYS = [
  'activationId',
  'admissionDigest',
  'planDigest',
  'canonicalRequestSha256',
  'trustRootCanonicalSha256',
  'configSha256',
  'homePath',
  'releasesRoot',
  'currentPointerPath',
  'plistPath',
  'candidateRevision',
  'candidateExpectedTree',
  'candidateVersion',
  'candidateReleaseTag',
  'candidateRuntimeTreeSha256',
  'candidateManifestDigest',
  'candidateLaunchReceiptSha256',
  'candidateServiceDescriptorSha256',
  'candidateServiceInvocationDigest',
  'candidateCurrentTarget',
  'rollbackRevision',
  'rollbackExpectedTree',
  'rollbackVersion',
  'rollbackReleaseTag',
  'rollbackRuntimeTreeSha256',
  'rollbackManifestDigest',
  'rollbackLaunchReceiptSha256',
  'rollbackServiceDescriptorSha256',
  'rollbackServiceInvocationDigest',
  'priorCurrentTarget',
  'priorPlistSha256',
  'priorServiceLoaded',
  'priorServiceDisabled',
  'hostUid',
  'serviceLabel',
  'serviceTarget',
] as const;

function boundedAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && posix.isAbsolute(value)
    && posix.resolve(value) === value
    && !value.includes('\0')
    && Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES;
}

function parseBindings(value: unknown): RuntimeActivationStoppedConsumerV2Bindings | null {
  const record = dataRecord(value, BINDING_KEYS);
  if (!record) return null;
  const digestFields = [
    record['admissionDigest'],
    record['planDigest'],
    record['canonicalRequestSha256'],
    record['trustRootCanonicalSha256'],
    record['configSha256'],
    record['candidateRuntimeTreeSha256'],
    record['candidateManifestDigest'],
    record['candidateLaunchReceiptSha256'],
    record['candidateServiceDescriptorSha256'],
    record['candidateServiceInvocationDigest'],
    record['rollbackRuntimeTreeSha256'],
    record['rollbackManifestDigest'],
    record['rollbackLaunchReceiptSha256'],
    record['rollbackServiceDescriptorSha256'],
    record['rollbackServiceInvocationDigest'],
    record['priorPlistSha256'],
  ];
  if (!digestFields.every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))) return null;
  if (typeof record['activationId'] !== 'string' || !UUID_RE.test(record['activationId'])
    || typeof record['candidateRevision'] !== 'string' || !SHA1_RE.test(record['candidateRevision'])
    || typeof record['candidateExpectedTree'] !== 'string' || !SHA1_RE.test(record['candidateExpectedTree'])
    || typeof record['rollbackRevision'] !== 'string' || !SHA1_RE.test(record['rollbackRevision'])
    || typeof record['rollbackExpectedTree'] !== 'string' || !SHA1_RE.test(record['rollbackExpectedTree'])
    || record['candidateRevision'] === record['rollbackRevision']
    || record['candidateExpectedTree'] === record['rollbackExpectedTree']
    || typeof record['candidateVersion'] !== 'string' || !PACKAGE_VERSION_RE.test(record['candidateVersion'])
    || typeof record['rollbackVersion'] !== 'string' || !PACKAGE_VERSION_RE.test(record['rollbackVersion'])
    || record['candidateReleaseTag'] !== `v${record['candidateVersion']}`
    || record['rollbackReleaseTag'] !== `v${record['rollbackVersion']}`
    || record['candidateCurrentTarget'] !== `releases/${record['candidateRevision']}`
    || record['priorCurrentTarget'] !== `releases/${record['rollbackRevision']}`
    || !boundedAbsolutePath(record['homePath'])
    || !boundedAbsolutePath(record['releasesRoot'])
    || !boundedAbsolutePath(record['currentPointerPath'])
    || !boundedAbsolutePath(record['plistPath'])
    || record['homePath'] === '/'
    || record['releasesRoot'] !== `${record['homePath']}/.local/share/ashlr/releases`
    || record['currentPointerPath'] !== `${record['homePath']}/.local/share/ashlr/current`
    || record['plistPath'] !== `${record['homePath']}/Library/LaunchAgents/ai.ashlr.daemon.plist`
    || record['priorServiceLoaded'] !== false
    || typeof record['priorServiceDisabled'] !== 'boolean'
    || !Number.isSafeInteger(record['hostUid'])
    || Number(record['hostUid']) < 0
    || Number(record['hostUid']) > 0xffff_ffff
    || record['serviceLabel'] !== 'ai.ashlr.daemon'
    || record['serviceTarget'] !== `gui/${record['hostUid']}/ai.ashlr.daemon`) return null;
  return record as unknown as RuntimeActivationStoppedConsumerV2Bindings;
}

function parseScope(value: unknown): RuntimeActivationStoppedConsumerV2PermitPayload['scope'] | null {
  const record = dataRecord(value, [
    'action',
    'platform',
    'nativeBrokerRequired',
    'nativeConditionalCasRequired',
    'maintenance',
    'killSwitch',
    'providerEffectsBlocked',
    'serviceLoaded',
    'serviceStart',
    'serviceEnable',
    'serviceInstall',
    'pointerSelectionRequested',
    'exactStoppedRollbackRequired',
    'residentAcknowledgement',
    'dispatchAuthorized',
  ]);
  if (!record
    || record['action'] !== 'select-exact-admitted-stopped-release'
    || record['platform'] !== 'darwin'
    || record['nativeBrokerRequired'] !== true
    || record['nativeConditionalCasRequired'] !== true
    || record['maintenance'] !== true
    || record['killSwitch'] !== 'healthy-engaged'
    || record['providerEffectsBlocked'] !== true
    || record['serviceLoaded'] !== false
    || record['serviceStart'] !== false
    || record['serviceEnable'] !== false
    || record['serviceInstall'] !== false
    || record['pointerSelectionRequested'] !== true
    || record['exactStoppedRollbackRequired'] !== true
    || record['residentAcknowledgement'] !== false
    || record['dispatchAuthorized'] !== false) return null;
  return record as unknown as RuntimeActivationStoppedConsumerV2PermitPayload['scope'];
}

function parsePermitPayload(value: unknown): RuntimeActivationStoppedConsumerV2PermitPayload | null {
  const payload = dataRecord(value, [
    'schemaVersion', 'protocol', 'permitId', 'keyId', 'issuedAt', 'expiresAt', 'scope', 'bindings',
  ]);
  if (!payload
    || payload['schemaVersion'] !== 2
    || payload['protocol'] !== RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL
    || typeof payload['permitId'] !== 'string' || !UUID_RE.test(payload['permitId'])
    || typeof payload['keyId'] !== 'string' || !KEY_ID_RE.test(payload['keyId'])
    || !canonicalTimestamp(payload['issuedAt'])
    || !canonicalTimestamp(payload['expiresAt'])
    || !parseScope(payload['scope'])
    || !parseBindings(payload['bindings'])) return null;
  return payload as unknown as RuntimeActivationStoppedConsumerV2PermitPayload;
}

export function parseRuntimeActivationStoppedConsumerV2Permit(
  value: unknown,
): RuntimeActivationStoppedConsumerV2PermitEnvelope | null {
  try {
    const envelope = dataRecord(value, ['payload', 'signature']);
    if (!envelope || canonicalBase64url(envelope['signature'], 64) === null) return null;
    if (!parsePermitPayload(envelope['payload'])) return null;
    return envelope as unknown as RuntimeActivationStoppedConsumerV2PermitEnvelope;
  } catch {
    return null;
  }
}

export function parseRuntimeActivationStoppedConsumerV2PermitFrame(
  input: string | Buffer,
): RuntimeActivationStoppedConsumerV2PermitEnvelope | null {
  const decoded = decodeCanonicalJsonFrame(input, MAX_PERMIT_FRAME_BYTES, canonicalizeDaemonActivationValue);
  return decoded ? parseRuntimeActivationStoppedConsumerV2Permit(decoded.value) : null;
}

function permitSigningBytes(payload: RuntimeActivationStoppedConsumerV2PermitPayload): Buffer {
  return Buffer.from(`${PERMIT_SIGNATURE_DOMAIN}${canonicalizeDaemonActivationValue(payload)}`, 'utf8');
}

export function runtimeActivationStoppedConsumerV2PermitPayloadDigest(
  payload: RuntimeActivationStoppedConsumerV2PermitPayload,
): string {
  return sha256(
    `${RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN}\n` +
    canonicalizeDaemonActivationValue(payload),
  );
}

export function runtimeActivationStoppedConsumerV2KeyId(publicKey: KeyObject): string {
  return runtimePermitKeyId(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN, publicKey);
}

export function signRuntimeActivationStoppedConsumerV2Permit(
  payload: RuntimeActivationStoppedConsumerV2PermitPayload,
  privateKey: KeyObject,
): RuntimeActivationStoppedConsumerV2PermitEnvelope {
  return {
    payload: structuredClone(payload),
    signature: sign(null, permitSigningBytes(payload), privateKey).toString('base64url'),
  };
}

export function runtimeActivationStoppedConsumerV2PermitFrame(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
): string {
  return `${canonicalizeDaemonActivationValue(envelope)}\n`;
}

export function verifyRuntimeActivationStoppedConsumerV2Permit(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
  roots: readonly RuntimeActivationStoppedConsumerV2TrustRoot[],
  nowMs: number,
): string | null {
  const parsed = parseRuntimeActivationStoppedConsumerV2Permit(envelope);
  if (!parsed) return 'runtime activation stopped-consumer v2 permit is invalid';
  return verifyEd25519RuntimePermit({
    label: 'runtime activation stopped-consumer v2',
    permitDomain: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN,
    issuedAt: parsed.payload.issuedAt,
    expiresAt: parsed.payload.expiresAt,
    keyId: parsed.payload.keyId,
    signature: parsed.signature,
    signingBytes: permitSigningBytes(parsed.payload),
    roots,
    nowMs,
    maxValidityMs: MAX_PERMIT_VALIDITY_MS,
    maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
    keyIdPattern: KEY_ID_RE,
    maxRoots: 8,
    requireOrderedRootWindow: true,
  });
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalValuesEqual(left, right, canonicalizeDaemonActivationValue);
}

/**
 * Authenticate a version-general permit and compare all independently derived
 * bindings. A successful result is evidence only; every authority bit remains
 * false and no permit is consumed.
 */
export function evaluateRuntimeActivationStoppedConsumerV2Permit(
  envelope: RuntimeActivationStoppedConsumerV2PermitEnvelope,
  roots: readonly RuntimeActivationStoppedConsumerV2TrustRoot[],
  nowMs: number,
  expectedBindings: RuntimeActivationStoppedConsumerV2Bindings,
): RuntimeActivationStoppedConsumerV2EvidenceResult {
  const failure = (reason: string): RuntimeActivationStoppedConsumerV2EvidenceResult => ({
    ok: false,
    reason,
    authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
    permitDigest: null,
  });
  const error = verifyRuntimeActivationStoppedConsumerV2Permit(envelope, roots, nowMs);
  if (error) return failure(error);
  const parsed = parseRuntimeActivationStoppedConsumerV2Permit(envelope);
  const expected = parseBindings(expectedBindings);
  if (!parsed || !expected || !canonicalEqual(parsed.payload.bindings, expected)) {
    return failure('runtime activation stopped-consumer v2 binding mismatch');
  }
  return {
    ok: true,
    reason: 'exact version-general stopped-selection permit matched; mutation authority remains external',
    authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
    permitDigest: runtimeActivationStoppedConsumerV2PermitPayloadDigest(parsed.payload),
  };
}
