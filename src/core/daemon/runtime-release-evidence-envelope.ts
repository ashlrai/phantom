import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import {
  RUNTIME_SHA256_RE as SHA256_RE,
  decodeCanonicalBase64url,
  domainBytesSha256,
  equalSha256Digest as equalHexDigest,
  hasExactKeys,
  isCanonicalTimestamp,
  isPlainRecord,
  parseStrictCanonicalJsonBytes as parseCanonicalJson,
  strictCanonicalJson as canonicalJson,
} from './runtime-protocol-shared.js';
import {
  parseUnsignedRuntimeReleaseManifest,
} from './runtime-release-manifest.js';

export const RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2 =
  'ashlr:runtime-release-evidence-envelope:v2' as const;
const RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V2 =
  'ashlr:runtime-release-evidence-trust-root:v2' as const;
const RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2 = 'ed25519' as const;
const RUNTIME_RELEASE_EVIDENCE_MAX_LIFETIME_MS_V2 = 15 * 60 * 1_000;

const SIGNATURE_INPUT_DOMAIN = 'ashlr:runtime-release-evidence-signature-input:v2';
const MANIFEST_CANONICAL_DIGEST_DOMAIN =
  'ashlr:runtime-release-evidence-manifest-canonical-bytes:v2';
const KEY_ID_DOMAIN = 'ashlr:runtime-release-evidence-key-id:v2';
const MAX_ENVELOPE_BYTES = 16 * 1_024;
const MAX_TRUST_ROOT_BYTES = 64 * 1_024;
const MAX_TRUST_KEYS = 32;
const MAX_PUBLIC_KEY_BYTES = 512;
const ED25519_SIGNATURE_BYTES = 64;
const REVISION_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;

export interface RuntimeReleaseEvidenceCoverageV2 {
  artifactCoherence: 'two-complete-scans';
  artifactSet:
    | 'package-manifest-dependency-inventory-launcher-dist-verifier'
    | 'package-manifest-dependency-inventory-launcher-dist-verifier-scorecard-worker';
  authenticity: 'envelope-signer-only';
  authority: 'observation-only';
  configuration: 'excluded';
  installedDependencies: 'packaged-byte-inventory-and-installed-tree';
  interpreter: 'caller-declared-artifact-observed';
  rollback: 'unresolved-caller-declared-reference';
  serviceInvocation: 'unbound';
}

export const RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2:
Readonly<RuntimeReleaseEvidenceCoverageV2> = Object.freeze({
  artifactCoherence: 'two-complete-scans',
  artifactSet: 'package-manifest-dependency-inventory-launcher-dist-verifier',
  authenticity: 'envelope-signer-only',
  authority: 'observation-only',
  configuration: 'excluded',
  installedDependencies: 'packaged-byte-inventory-and-installed-tree',
  interpreter: 'caller-declared-artifact-observed',
  rollback: 'unresolved-caller-declared-reference',
  serviceInvocation: 'unbound',
});

export const RUNTIME_RELEASE_EVIDENCE_CURRENT_COVERAGE_V3:
Readonly<RuntimeReleaseEvidenceCoverageV2> = Object.freeze({
  ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2,
  artifactSet: 'package-manifest-dependency-inventory-launcher-dist-verifier-scorecard-worker',
});

export interface RuntimeReleaseEvidencePayloadV2 {
  assurance: 'signed-observation-only';
  coverage: RuntimeReleaseEvidenceCoverageV2;
  expiresAt: string;
  expectedRevision: string;
  issuedAt: string;
  manifestCanonicalSha256: string;
  manifestDigest: string;
  schemaVersion: 2;
}

export interface SignedRuntimeReleaseEvidenceEnvelopeV2 {
  algorithm: typeof RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2;
  domain: typeof RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2;
  keyId: string;
  payload: RuntimeReleaseEvidencePayloadV2;
  schemaVersion: 2;
  signature: string;
}

export interface RuntimeReleaseEvidenceTrustKeyV2 {
  algorithm: typeof RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2;
  keyId: string;
  publicKeySpki: string;
  validFrom: string;
  validUntil: string;
}

export interface RuntimeReleaseEvidenceTrustRootV2 {
  assurance: 'caller-provided-public-key-trust-root';
  domain: typeof RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V2;
  keys: RuntimeReleaseEvidenceTrustKeyV2[];
  requiredCoverage: RuntimeReleaseEvidenceCoverageV2;
  schemaVersion: 2;
}

export interface BuildRuntimeReleaseEvidenceTrustRootOptions {
  keys: Array<{
    publicKey: KeyObject;
    validFrom: string;
    validUntil: string;
  }>;
}

export type BuildRuntimeReleaseEvidenceTrustRootResult =
  | {
    ok: true;
    trustRoot: RuntimeReleaseEvidenceTrustRootV2;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export interface SignRuntimeReleaseEvidenceEnvelopeOptions {
  expiresAt: string;
  issuedAt: string;
  manifest: string | Buffer;
  privateKey: KeyObject;
}

export type SignRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    envelope: SignedRuntimeReleaseEvidenceEnvelopeV2;
    canonicalJson: string;
    keyId: string;
  }
  | { ok: false; reason: string };

export type ParseRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    envelope: SignedRuntimeReleaseEvidenceEnvelopeV2;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export type ParseRuntimeReleaseEvidenceTrustRootResult =
  | {
    ok: true;
    trustRoot: RuntimeReleaseEvidenceTrustRootV2;
    canonicalJson: string;
  }
  | { ok: false; reason: string };

export interface VerifyRuntimeReleaseEvidenceEnvelopeOptions {
  envelope: string | Buffer;
  manifest: string | Buffer;
  trustRoot: string | Buffer;
}

export type VerifyRuntimeReleaseEvidenceEnvelopeResult =
  | {
    ok: true;
    assurance: 'signed-observation-only';
    expiresAt: string;
    issuedAt: string;
    keyId: string;
    manifestDigest: string;
    expectedRevision: string;
    rollbackTargetManifestDigest: string | null;
    verifiedAtMs: number;
  }
  | { ok: false; reason: string };

type UnsignedEnvelope = Omit<SignedRuntimeReleaseEvidenceEnvelopeV2, 'signature'>;

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length !== 24 || !isCanonicalTimestamp(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestampMs(value: string): number {
  return Date.parse(value);
}

function validateLifetime(issuedAt: string, expiresAt: string, label: string): void {
  const lifetime = timestampMs(expiresAt) - timestampMs(issuedAt);
  if (lifetime <= 0 || lifetime > RUNTIME_RELEASE_EVIDENCE_MAX_LIFETIME_MS_V2) {
    throw new Error(`${label} lifetime is invalid`);
  }
}

function coverageFrom(value: unknown, label: string): RuntimeReleaseEvidenceCoverageV2 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'artifactCoherence',
    'artifactSet',
    'authenticity',
    'authority',
    'configuration',
    'installedDependencies',
    'interpreter',
    'rollback',
    'serviceInvocation',
  ]) ||
    value['artifactCoherence'] !== 'two-complete-scans' ||
    (value['artifactSet'] !== 'package-manifest-dependency-inventory-launcher-dist-verifier' &&
      value['artifactSet'] !==
        'package-manifest-dependency-inventory-launcher-dist-verifier-scorecard-worker') ||
    value['authenticity'] !== 'envelope-signer-only' ||
    value['authority'] !== 'observation-only' ||
    value['configuration'] !== 'excluded' ||
    value['installedDependencies'] !== 'packaged-byte-inventory-and-installed-tree' ||
    value['interpreter'] !== 'caller-declared-artifact-observed' ||
    value['rollback'] !== 'unresolved-caller-declared-reference' ||
    value['serviceInvocation'] !== 'unbound') {
    throw new Error(`${label} is incomplete or unsupported`);
  }
  return {
    ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2,
    artifactSet: value['artifactSet'],
  };
}

function manifestCoverage(
  schemaVersion: 2 | 3,
): Readonly<RuntimeReleaseEvidenceCoverageV2> {
  return schemaVersion === 3
    ? RUNTIME_RELEASE_EVIDENCE_CURRENT_COVERAGE_V3
    : RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2;
}

function coverageSatisfiesTrustRoot(
  actual: RuntimeReleaseEvidenceCoverageV2,
  required: RuntimeReleaseEvidenceCoverageV2,
): boolean {
  if (canonicalJson(actual) === canonicalJson(required)) return true;
  return required.artifactSet ===
      RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2.artifactSet &&
    actual.artifactSet === RUNTIME_RELEASE_EVIDENCE_CURRENT_COVERAGE_V3.artifactSet &&
    canonicalJson({ ...actual, artifactSet: required.artifactSet }) === canonicalJson(required);
}

function decodeBase64url(value: unknown, expectedBytes?: number): Buffer | null {
  return decodeCanonicalBase64url(value, expectedBytes, MAX_PUBLIC_KEY_BYTES);
}

function publicKeyDer(publicKey: KeyObject): Buffer {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('runtime release evidence public key must be Ed25519');
  }
  const exported = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(exported) || exported.length === 0 ||
    exported.length > MAX_PUBLIC_KEY_BYTES) {
    throw new Error('runtime release evidence public key encoding is invalid');
  }
  return exported;
}

function keyIdForDer(der: Buffer): string {
  return `ed25519-sha256:${domainBytesSha256(KEY_ID_DOMAIN, der)}`;
}

export function runtimeReleaseEvidenceKeyId(publicKey: KeyObject): string | null {
  try {
    return keyIdForDer(publicKeyDer(publicKey));
  } catch {
    return null;
  }
}

function trustKeyFrom(
  value: unknown,
  previousKeyId: string | null,
): { key: RuntimeReleaseEvidenceTrustKeyV2; publicKey: KeyObject } {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'keyId',
    'publicKeySpki',
    'validFrom',
    'validUntil',
  ])) {
    throw new Error('runtime release evidence trust key shape is invalid');
  }
  if (value['algorithm'] !== RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2) {
    throw new Error('runtime release evidence trust key algorithm is unsupported');
  }
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) {
    throw new Error('runtime release evidence trust key id is invalid');
  }
  if (previousKeyId !== null && value['keyId'] <= previousKeyId) {
    throw new Error('runtime release evidence trust keys must be unique and sorted');
  }
  const der = decodeBase64url(value['publicKeySpki']);
  if (!der) throw new Error('runtime release evidence public key encoding is invalid');
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('runtime release evidence public key is invalid');
  }
  const normalizedDer = publicKeyDer(publicKey);
  if (!normalizedDer.equals(der) || keyIdForDer(der) !== value['keyId']) {
    throw new Error('runtime release evidence trust key id does not match public key');
  }
  const validFrom = canonicalTimestamp(
    value['validFrom'],
    'runtime release evidence trust key validFrom',
  );
  const validUntil = canonicalTimestamp(
    value['validUntil'],
    'runtime release evidence trust key validUntil',
  );
  if (timestampMs(validUntil) <= timestampMs(validFrom)) {
    throw new Error('runtime release evidence trust key validity is invalid');
  }
  return {
    key: {
      algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2,
      keyId: value['keyId'],
      publicKeySpki: value['publicKeySpki'] as string,
      validFrom,
      validUntil,
    },
    publicKey,
  };
}

function validateTrustRoot(
  value: unknown,
): {
  trustRoot: RuntimeReleaseEvidenceTrustRootV2;
  publicKeys: Map<string, KeyObject>;
} {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'assurance',
    'domain',
    'keys',
    'requiredCoverage',
    'schemaVersion',
  ])) {
    throw new Error('runtime release evidence trust root shape is invalid');
  }
  if (value['schemaVersion'] !== 2) {
    throw new Error('runtime release evidence trust root schema is unsupported');
  }
  if (value['domain'] !== RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V2) {
    throw new Error('runtime release evidence trust root domain is unsupported');
  }
  if (value['assurance'] !== 'caller-provided-public-key-trust-root') {
    throw new Error('runtime release evidence trust root assurance is unsupported');
  }
  const keysValue = value['keys'];
  if (!Array.isArray(keysValue) || keysValue.length === 0 ||
    keysValue.length > MAX_TRUST_KEYS) {
    throw new Error('runtime release evidence trust key count is invalid');
  }
  const keys: RuntimeReleaseEvidenceTrustKeyV2[] = [];
  const publicKeys = new Map<string, KeyObject>();
  let previousKeyId: string | null = null;
  for (const entry of keysValue) {
    const parsed = trustKeyFrom(entry, previousKeyId);
    keys.push(parsed.key);
    publicKeys.set(parsed.key.keyId, parsed.publicKey);
    previousKeyId = parsed.key.keyId;
  }
  return {
    trustRoot: {
      assurance: 'caller-provided-public-key-trust-root',
      domain: RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V2,
      keys,
      requiredCoverage: coverageFrom(
        value['requiredCoverage'],
        'runtime release evidence required coverage',
      ),
      schemaVersion: 2,
    },
    publicKeys,
  };
}

function validateEnvelope(value: unknown): SignedRuntimeReleaseEvidenceEnvelopeV2 {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'algorithm',
    'domain',
    'keyId',
    'payload',
    'schemaVersion',
    'signature',
  ])) {
    throw new Error('runtime release evidence envelope shape is invalid');
  }
  if (value['schemaVersion'] !== 2) {
    throw new Error('runtime release evidence envelope schema is unsupported');
  }
  if (value['domain'] !== RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2) {
    throw new Error('runtime release evidence envelope domain is unsupported');
  }
  if (value['algorithm'] !== RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2) {
    throw new Error('runtime release evidence envelope algorithm is unsupported');
  }
  if (typeof value['keyId'] !== 'string' || !KEY_ID_RE.test(value['keyId'])) {
    throw new Error('runtime release evidence envelope key id is invalid');
  }
  const signature = decodeBase64url(value['signature'], ED25519_SIGNATURE_BYTES);
  if (!signature) throw new Error('runtime release evidence signature is invalid');

  const payload = value['payload'];
  if (!isPlainRecord(payload) || !hasExactKeys(payload, [
    'assurance',
    'coverage',
    'expiresAt',
    'expectedRevision',
    'issuedAt',
    'manifestCanonicalSha256',
    'manifestDigest',
    'schemaVersion',
  ])) {
    throw new Error('runtime release evidence payload shape is invalid');
  }
  if (payload['schemaVersion'] !== 2 ||
    payload['assurance'] !== 'signed-observation-only') {
    throw new Error('runtime release evidence payload schema is unsupported');
  }
  if (typeof payload['expectedRevision'] !== 'string' ||
    !REVISION_RE.test(payload['expectedRevision'])) {
    throw new Error('runtime release evidence expected revision is invalid');
  }
  if (typeof payload['manifestDigest'] !== 'string' ||
    !SHA256_RE.test(payload['manifestDigest']) ||
    typeof payload['manifestCanonicalSha256'] !== 'string' ||
    !SHA256_RE.test(payload['manifestCanonicalSha256'])) {
    throw new Error('runtime release evidence manifest identity is invalid');
  }
  const issuedAt = canonicalTimestamp(
    payload['issuedAt'],
    'runtime release evidence issuedAt',
  );
  const expiresAt = canonicalTimestamp(
    payload['expiresAt'],
    'runtime release evidence expiresAt',
  );
  validateLifetime(issuedAt, expiresAt, 'runtime release evidence');
  return {
    algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2,
    domain: RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2,
    keyId: value['keyId'],
    payload: {
      assurance: 'signed-observation-only',
      coverage: coverageFrom(
        payload['coverage'],
        'runtime release evidence coverage',
      ),
      expiresAt,
      expectedRevision: payload['expectedRevision'],
      issuedAt,
      manifestCanonicalSha256: payload['manifestCanonicalSha256'],
      manifestDigest: payload['manifestDigest'],
      schemaVersion: 2,
    },
    schemaVersion: 2,
    signature: value['signature'] as string,
  };
}

function unsignedEnvelope(envelope: SignedRuntimeReleaseEvidenceEnvelopeV2): UnsignedEnvelope {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function signatureInput(envelope: UnsignedEnvelope): Buffer {
  return Buffer.concat([
    Buffer.from(`${SIGNATURE_INPUT_DOMAIN}\n`, 'utf8'),
    Buffer.from(canonicalJson(envelope), 'utf8'),
  ]);
}

function manifestCanonicalSha256(canonicalManifest: string): string {
  return domainBytesSha256(MANIFEST_CANONICAL_DIGEST_DOMAIN, canonicalManifest);
}

export function buildRuntimeReleaseEvidenceTrustRoot(
  options: BuildRuntimeReleaseEvidenceTrustRootOptions,
): BuildRuntimeReleaseEvidenceTrustRootResult {
  try {
    if (!Array.isArray(options.keys) || options.keys.length === 0 ||
      options.keys.length > MAX_TRUST_KEYS) {
      return { ok: false, reason: 'runtime release evidence trust key count is invalid' };
    }
    const keys = options.keys.map((entry): RuntimeReleaseEvidenceTrustKeyV2 => {
      const der = publicKeyDer(entry.publicKey);
      const validFrom = canonicalTimestamp(
        entry.validFrom,
        'runtime release evidence trust key validFrom',
      );
      const validUntil = canonicalTimestamp(
        entry.validUntil,
        'runtime release evidence trust key validUntil',
      );
      if (timestampMs(validUntil) <= timestampMs(validFrom)) {
        throw new Error('runtime release evidence trust key validity is invalid');
      }
      return {
        algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2,
        keyId: keyIdForDer(der),
        publicKeySpki: der.toString('base64url'),
        validFrom,
        validUntil,
      };
    }).sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
    if (keys.some((entry, index) => index > 0 && entry.keyId === keys[index - 1]!.keyId)) {
      return { ok: false, reason: 'runtime release evidence trust keys must be unique' };
    }
    const trustRoot: RuntimeReleaseEvidenceTrustRootV2 = {
      assurance: 'caller-provided-public-key-trust-root',
      domain: RUNTIME_RELEASE_EVIDENCE_TRUST_ROOT_DOMAIN_V2,
      keys,
      requiredCoverage: { ...RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2 },
      schemaVersion: 2,
    };
    const encoded = `${canonicalJson(trustRoot)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_TRUST_ROOT_BYTES) {
      return { ok: false, reason: 'runtime release evidence trust root exceeds byte limit' };
    }
    return { ok: true, trustRoot, canonicalJson: encoded };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function parseRuntimeReleaseEvidenceTrustRoot(
  input: string | Buffer,
): ParseRuntimeReleaseEvidenceTrustRootResult {
  try {
    const parsed = parseCanonicalJson(
      input,
      MAX_TRUST_ROOT_BYTES,
      'runtime release evidence trust root',
    );
    const { trustRoot } = validateTrustRoot(parsed.value);
    return { ok: true, trustRoot, canonicalJson: parsed.canonicalJson };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function signRuntimeReleaseEvidenceEnvelope(
  options: SignRuntimeReleaseEvidenceEnvelopeOptions,
): SignRuntimeReleaseEvidenceEnvelopeResult {
  try {
    if (options.privateKey.type !== 'private' ||
      options.privateKey.asymmetricKeyType !== 'ed25519') {
      return { ok: false, reason: 'runtime release evidence private key must be Ed25519' };
    }
    const manifest = parseUnsignedRuntimeReleaseManifest(options.manifest);
    if (!manifest.ok) return manifest;
    const issuedAt = canonicalTimestamp(options.issuedAt, 'runtime release evidence issuedAt');
    const expiresAt = canonicalTimestamp(options.expiresAt, 'runtime release evidence expiresAt');
    validateLifetime(issuedAt, expiresAt, 'runtime release evidence');
    const publicKey = createPublicKey(options.privateKey);
    const keyId = keyIdForDer(publicKeyDer(publicKey));
    const unsigned: UnsignedEnvelope = {
      algorithm: RUNTIME_RELEASE_EVIDENCE_SIGNATURE_ALGORITHM_V2,
      domain: RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2,
      keyId,
      payload: {
        assurance: 'signed-observation-only',
        coverage: { ...manifestCoverage(manifest.manifest.schemaVersion) },
        expiresAt,
        expectedRevision: manifest.manifest.expectedRevision,
        issuedAt,
        manifestCanonicalSha256: manifestCanonicalSha256(manifest.canonicalJson),
        manifestDigest: manifest.manifest.manifestDigest,
        schemaVersion: 2,
      },
      schemaVersion: 2,
    };
    const signature = cryptoSign(null, signatureInput(unsigned), options.privateKey);
    if (signature.length !== ED25519_SIGNATURE_BYTES) {
      return { ok: false, reason: 'runtime release evidence signature length is invalid' };
    }
    const envelope: SignedRuntimeReleaseEvidenceEnvelopeV2 = {
      ...unsigned,
      signature: signature.toString('base64url'),
    };
    const encoded = `${canonicalJson(envelope)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ENVELOPE_BYTES) {
      return { ok: false, reason: 'runtime release evidence envelope exceeds byte limit' };
    }
    return { ok: true, envelope, canonicalJson: encoded, keyId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function parseRuntimeReleaseEvidenceEnvelope(
  input: string | Buffer,
): ParseRuntimeReleaseEvidenceEnvelopeResult {
  try {
    const parsed = parseCanonicalJson(
      input,
      MAX_ENVELOPE_BYTES,
      'runtime release evidence envelope',
    );
    const envelope = validateEnvelope(parsed.value);
    return { ok: true, envelope, canonicalJson: parsed.canonicalJson };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function verifyRuntimeReleaseEvidenceEnvelope(
  options: VerifyRuntimeReleaseEvidenceEnvelopeOptions,
): VerifyRuntimeReleaseEvidenceEnvelopeResult {
  try {
    const manifest = parseUnsignedRuntimeReleaseManifest(options.manifest);
    if (!manifest.ok) return manifest;
    const envelope = parseRuntimeReleaseEvidenceEnvelope(options.envelope);
    if (!envelope.ok) return envelope;
    const parsedTrustRoot = parseCanonicalJson(
      options.trustRoot,
      MAX_TRUST_ROOT_BYTES,
      'runtime release evidence trust root',
    );
    const { trustRoot, publicKeys } = validateTrustRoot(parsedTrustRoot.value);
    const nowMs = Date.now();
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
      return { ok: false, reason: 'runtime release evidence trusted clock is invalid' };
    }

    const key = trustRoot.keys.find((candidate) =>
      candidate.keyId === envelope.envelope.keyId);
    if (!key) return { ok: false, reason: 'runtime release evidence signing key is unknown' };
    if (key.algorithm !== envelope.envelope.algorithm) {
      return { ok: false, reason: 'runtime release evidence key algorithm mismatch' };
    }
    const publicKey = publicKeys.get(key.keyId);
    if (!publicKey) {
      return { ok: false, reason: 'runtime release evidence signing key is unavailable' };
    }
    const signature = decodeBase64url(
      envelope.envelope.signature,
      ED25519_SIGNATURE_BYTES,
    );
    if (!signature || !cryptoVerify(
      null,
      signatureInput(unsignedEnvelope(envelope.envelope)),
      publicKey,
      signature,
    )) {
      return { ok: false, reason: 'runtime release evidence signature verification failed' };
    }
    if (timestampMs(envelope.envelope.payload.issuedAt) < timestampMs(key.validFrom) ||
      timestampMs(envelope.envelope.payload.expiresAt) > timestampMs(key.validUntil)) {
      return {
        ok: false,
        reason: 'runtime release evidence falls outside signing key validity',
      };
    }
    if (!coverageSatisfiesTrustRoot(
      envelope.envelope.payload.coverage,
      trustRoot.requiredCoverage,
    )) {
      return { ok: false, reason: 'runtime release evidence does not meet required coverage' };
    }
    if (canonicalJson(envelope.envelope.payload.coverage) !==
      canonicalJson(manifestCoverage(manifest.manifest.schemaVersion))) {
      return {
        ok: false,
        reason: 'runtime release evidence coverage does not match manifest schema',
      };
    }
    if (!equalHexDigest(
      envelope.envelope.payload.manifestDigest,
      manifest.manifest.manifestDigest,
    )) {
      return { ok: false, reason: 'runtime release evidence manifest digest mismatch' };
    }
    if (!equalHexDigest(
      envelope.envelope.payload.manifestCanonicalSha256,
      manifestCanonicalSha256(manifest.canonicalJson),
    )) {
      return {
        ok: false,
        reason: 'runtime release evidence canonical manifest digest mismatch',
      };
    }
    if (envelope.envelope.payload.expectedRevision !== manifest.manifest.expectedRevision) {
      return { ok: false, reason: 'runtime release evidence expected revision mismatch' };
    }
    if (nowMs < timestampMs(envelope.envelope.payload.issuedAt)) {
      return { ok: false, reason: 'runtime release evidence is not yet valid' };
    }
    if (nowMs >= timestampMs(envelope.envelope.payload.expiresAt)) {
      return { ok: false, reason: 'runtime release evidence is stale' };
    }
    return {
      ok: true,
      assurance: 'signed-observation-only',
      expiresAt: envelope.envelope.payload.expiresAt,
      issuedAt: envelope.envelope.payload.issuedAt,
      keyId: envelope.envelope.keyId,
      manifestDigest: envelope.envelope.payload.manifestDigest,
      expectedRevision: envelope.envelope.payload.expectedRevision,
      rollbackTargetManifestDigest:
        manifest.manifest.rollbackDeclaration.targetManifestDigest,
      verifiedAtMs: nowMs,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
