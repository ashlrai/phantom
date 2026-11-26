/**
 * Pure compiler for caller-supplied Stack effect proposals.
 *
 * Parsing and digest verification never constitute approval. This module has
 * no discovery or execution surface: no files, environment, processes,
 * providers, network, credentials, or secrets are read. Targets, predicates,
 * diffs, rollback plans, and idempotency keys are accepted only as opaque
 * digests. V1 is pinned to the audited stable Stack 0.2.x producer family.
 */

import {
  SHA256_PREFIXED_DIGEST_RE as DIGEST_RE,
  canonicalJsonBytes,
  decodeStrictUtf8JsonBytes,
  deepFreeze as immutable,
  exactKeys,
  isCanonicalIsoTimestamp as canonicalIso,
  isEnumValue as enumValue,
  isSafeIntegerInRange as integer,
  isUnsupportedStackSourceVersionV1 as unsupportedSourceVersion,
  isValidStackSourceV1 as validSource,
  sha256Prefixed as sha,
  strictPlainRecord as record,
  timingSafeUtf8Equal as sameText,
  type StackSourceMetadataV1,
} from './external-contract-codec.js';

export const STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL = 'ashlr-stack-planned-effect-manifest-v1' as const;
const EXTERNAL_STACK_EFFECT_PLAN_PROTOCOL = 'ashlr-external-stack-effect-plan-v1' as const;
export const STACK_PLANNED_EFFECT_MAX_BYTES = 64 * 1024;
const STACK_PLANNED_EFFECT_MAX_LIFETIME_MS = 10 * 60_000;
const STACK_PLANNED_EFFECT_MAX_FUTURE_SKEW_MS = 60_000;

const CANONICAL_BOUNDS = { maxDepth: 12, maxNodes: 2_000, maxBytes: STACK_PLANNED_EFFECT_MAX_BYTES };
const MAX_ESTIMATED_COST_MICRO_UNITS = 1_000_000_000_000;

const STACK_EFFECT_CLASSES_V1 = [
  'configuration',
  'deployment',
  'filesystem',
  'provider-resource',
  'runtime',
  'source-control',
] as const;

const STACK_EFFECT_VERBS_V1 = [
  'apply',
  'create',
  'delete',
  'deploy',
  'restart',
  'revert',
  'rollback',
  'start',
  'stop',
  'update',
] as const;

const CURRENCIES = ['CAD', 'EUR', 'GBP', 'USD'] as const;
const SECRET_CAPABILITY_CLASSES = [
  'artifact-publisher',
  'deployment-control',
  'provider-control',
  'source-control',
] as const;
const ROLLBACK_CLASSES = ['automatic', 'not-applicable', 'operator-assisted'] as const;

export type StackEffectClassV1 = typeof STACK_EFFECT_CLASSES_V1[number];
export type StackEffectVerbV1 = typeof STACK_EFFECT_VERBS_V1[number];
export type StackEffectCurrencyV1 = typeof CURRENCIES[number];
export type StackSecretCapabilityClassV1 = typeof SECRET_CAPABILITY_CLASSES[number];
export type StackRollbackClassV1 = typeof ROLLBACK_CLASSES[number];

export type StackEstimatedCostV1 =
  | { known: true; amountMicroUnits: number; currency: StackEffectCurrencyV1 }
  | { known: false; amountMicroUnits: null; currency: null };

export interface StackPlannedEffectManifestV1 {
  schemaVersion: 1;
  protocol: typeof STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL;
  artifactClass: 'effect-proposal';
  source: StackSourceMetadataV1;
  generatedAt: string;
  expiresAt: string;
  targetDigest: string;
  effect: {
    class: StackEffectClassV1;
    verb: StackEffectVerbV1;
  };
  observationManifestDigest: string;
  preconditionsDigest: string;
  expectedDiffDigest: string;
  idempotencyKeyDigest: string;
  estimatedCost: StackEstimatedCostV1;
  requiredSecretCapabilityClass: StackSecretCapabilityClassV1 | null;
  rollback: {
    class: StackRollbackClassV1;
    planDigest: string | null;
  };
  acceptancePredicateDigest: string;
  manifestDigest: string;
}

export interface ExternalStackEffectPlanV1 {
  schemaVersion: 1;
  protocol: 'ashlr-external-stack-effect-plan-v1';
  recordType: 'external-stack-effect-plan';
  artifactClass: 'effect-proposal';
  verification: 'local-unverified';
  authenticated: false;
  trusted: false;
  authority: false;
  effectAuthority: false;
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  approvalAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  secretAccessAuthority: false;
  eligible: false;
  planningEligible: false;
  executionEligible: false;
  policyEligible: false;
  promotionEligible: false;
  approved: false;
  performed: false;
  effectPerformed: false;
  source: StackPlannedEffectManifestV1['source'];
  generatedAt: string;
  expiresAt: string;
  targetDigest: string;
  effect: StackPlannedEffectManifestV1['effect'];
  observationManifestDigest: string;
  preconditionsDigest: string;
  expectedDiffDigest: string;
  idempotencyKeyDigest: string;
  estimatedCost: StackEstimatedCostV1;
  requiredSecretCapabilityClass: StackSecretCapabilityClassV1 | null;
  rollback: StackPlannedEffectManifestV1['rollback'];
  acceptancePredicateDigest: string;
  manifestDigest: string;
  planDigest: string;
}

export type ExternalStackEffectPlanIssueV1 =
  | 'invalid-bytes'
  | 'oversized-manifest'
  | 'non-canonical-json'
  | 'invalid-manifest'
  | 'unsupported-version'
  | 'future-manifest'
  | 'stale-manifest'
  | 'manifest-digest-mismatch'
  | 'invalid-effect'
  | 'invalid-cost'
  | 'invalid-rollback';

export type ExternalStackEffectPlanResultV1 =
  | { ok: true; plan: ExternalStackEffectPlanV1; issues: [] }
  | { ok: false; plan: null; issues: [ExternalStackEffectPlanIssueV1] };

const MANIFEST_KEYS = [
  'acceptancePredicateDigest', 'artifactClass', 'effect', 'estimatedCost', 'expectedDiffDigest', 'expiresAt',
  'generatedAt', 'idempotencyKeyDigest', 'manifestDigest', 'observationManifestDigest', 'preconditionsDigest',
  'protocol', 'requiredSecretCapabilityClass', 'rollback', 'schemaVersion', 'source', 'targetDigest',
] as const;
const UNSIGNED_MANIFEST_KEYS = MANIFEST_KEYS.filter((key) => key !== 'manifestDigest');
const EFFECT_KEYS = ['class', 'verb'] as const;
const COST_KEYS = ['amountMicroUnits', 'currency', 'known'] as const;
const ROLLBACK_KEYS = ['class', 'planDigest'] as const;

const VERBS_BY_CLASS: Readonly<Record<StackEffectClassV1, readonly StackEffectVerbV1[]>> = {
  configuration: ['apply', 'revert'],
  deployment: ['deploy', 'rollback'],
  filesystem: ['create', 'delete', 'update'],
  'provider-resource': ['create', 'delete', 'update'],
  runtime: ['restart', 'start', 'stop'],
  'source-control': ['apply', 'revert'],
};

function canonicalBytes(value: unknown): Buffer | null {
  return canonicalJsonBytes(value, CANONICAL_BOUNDS);
}

function validEffect(value: unknown): value is StackPlannedEffectManifestV1['effect'] {
  const effect = record(value);
  if (!effect || !exactKeys(effect, EFFECT_KEYS) || !enumValue(effect['class'], STACK_EFFECT_CLASSES_V1) ||
    !enumValue(effect['verb'], STACK_EFFECT_VERBS_V1)) return false;
  return VERBS_BY_CLASS[effect['class']].includes(effect['verb']);
}

function validCost(value: unknown): value is StackEstimatedCostV1 {
  const cost = record(value);
  if (!cost || !exactKeys(cost, COST_KEYS) || typeof cost['known'] !== 'boolean') return false;
  if (!cost['known']) return cost['amountMicroUnits'] === null && cost['currency'] === null;
  return integer(cost['amountMicroUnits'], 0, MAX_ESTIMATED_COST_MICRO_UNITS) && enumValue(cost['currency'], CURRENCIES);
}

function validRollback(value: unknown): value is StackPlannedEffectManifestV1['rollback'] {
  const rollback = record(value);
  if (!rollback || !exactKeys(rollback, ROLLBACK_KEYS) || !enumValue(rollback['class'], ROLLBACK_CLASSES)) return false;
  return rollback['class'] === 'not-applicable'
    ? rollback['planDigest'] === null
    : typeof rollback['planDigest'] === 'string' && DIGEST_RE.test(rollback['planDigest']);
}

function unsignedManifest(value: unknown): Omit<StackPlannedEffectManifestV1, 'manifestDigest'> | null {
  const manifest = record(value);
  if (!manifest || !exactKeys(manifest, MANIFEST_KEYS) || manifest['schemaVersion'] !== 1 ||
    manifest['protocol'] !== STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL || manifest['artifactClass'] !== 'effect-proposal' ||
    !validSource(manifest['source']) || !canonicalIso(manifest['generatedAt']) ||
    !canonicalIso(manifest['expiresAt']) || typeof manifest['targetDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['targetDigest']) || !validEffect(manifest['effect']) ||
    typeof manifest['observationManifestDigest'] !== 'string' || !DIGEST_RE.test(manifest['observationManifestDigest']) ||
    typeof manifest['preconditionsDigest'] !== 'string' || !DIGEST_RE.test(manifest['preconditionsDigest']) ||
    typeof manifest['expectedDiffDigest'] !== 'string' || !DIGEST_RE.test(manifest['expectedDiffDigest']) ||
    typeof manifest['idempotencyKeyDigest'] !== 'string' || !DIGEST_RE.test(manifest['idempotencyKeyDigest']) ||
    !validCost(manifest['estimatedCost']) ||
    (manifest['requiredSecretCapabilityClass'] !== null &&
      !enumValue(manifest['requiredSecretCapabilityClass'], SECRET_CAPABILITY_CLASSES)) ||
    !validRollback(manifest['rollback']) || typeof manifest['acceptancePredicateDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['acceptancePredicateDigest']) || typeof manifest['manifestDigest'] !== 'string' ||
    !DIGEST_RE.test(manifest['manifestDigest'])) return null;
  return Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]])) as
    Omit<StackPlannedEffectManifestV1, 'manifestDigest'>;
}

/** Canonical exact proposal bytes. Unknown or privacy-bearing fields fail. */
export function canonicalStackPlannedEffectManifestBytesV1(value: unknown): Buffer | null {
  return unsignedManifest(value) ? canonicalBytes(value) : null;
}

/** Domain-separated consistency digest over every manifest field except itself. */
export function stackPlannedEffectManifestDigestV1(value: unknown): string | null {
  const manifest = record(value);
  if (!manifest) return null;
  const unsigned = exactKeys(manifest, UNSIGNED_MANIFEST_KEYS)
    ? manifest
    : exactKeys(manifest, MANIFEST_KEYS)
      ? Object.fromEntries(UNSIGNED_MANIFEST_KEYS.map((key) => [key, manifest[key]]))
      : null;
  const bytes = unsigned ? canonicalBytes(unsigned) : null;
  return bytes ? sha('ashlr:stack-planned-effect-manifest:v1', bytes) : null;
}

function fail(issue: ExternalStackEffectPlanIssueV1): ExternalStackEffectPlanResultV1 {
  return immutable({ ok: false, plan: null, issues: [issue] });
}

function planOf(manifest: StackPlannedEffectManifestV1): ExternalStackEffectPlanV1 {
  const plan = {
    schemaVersion: 1 as const,
    protocol: EXTERNAL_STACK_EFFECT_PLAN_PROTOCOL,
    recordType: 'external-stack-effect-plan' as const,
    artifactClass: 'effect-proposal' as const,
    verification: 'local-unverified' as const,
    authenticated: false as const,
    trusted: false as const,
    authority: false as const,
    effectAuthority: false as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    proposalAuthority: false as const,
    approvalAuthority: false as const,
    policyAuthority: false as const,
    promotionAuthority: false as const,
    mergeAuthority: false as const,
    releaseAuthority: false as const,
    deployAuthority: false as const,
    publicationAuthority: false as const,
    externalMutationAuthority: false as const,
    secretAccessAuthority: false as const,
    eligible: false as const,
    planningEligible: false as const,
    executionEligible: false as const,
    policyEligible: false as const,
    promotionEligible: false as const,
    approved: false as const,
    performed: false as const,
    effectPerformed: false as const,
    source: manifest.source,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    targetDigest: manifest.targetDigest,
    effect: manifest.effect,
    observationManifestDigest: manifest.observationManifestDigest,
    preconditionsDigest: manifest.preconditionsDigest,
    expectedDiffDigest: manifest.expectedDiffDigest,
    idempotencyKeyDigest: manifest.idempotencyKeyDigest,
    estimatedCost: manifest.estimatedCost,
    requiredSecretCapabilityClass: manifest.requiredSecretCapabilityClass,
    rollback: manifest.rollback,
    acceptancePredicateDigest: manifest.acceptancePredicateDigest,
    manifestDigest: manifest.manifestDigest,
  };
  return immutable({
    ...plan,
    planDigest: sha('ashlr:external-stack-effect-plan:v1', canonicalBytes(plan)!),
  });
}

/** Compile exact canonical caller bytes into an inert, never-approved proposal. */
export function compileExternalStackEffectPlanV1(
  bytes: Uint8Array,
  now: Date = new Date(),
): ExternalStackEffectPlanResultV1 {
  try {
    const decoded = decodeStrictUtf8JsonBytes(bytes, STACK_PLANNED_EFFECT_MAX_BYTES, now);
    if (!decoded.ok) {
      return fail(decoded.reason === 'oversized' ? 'oversized-manifest' : decoded.reason);
    }
    const { copied, parsed } = decoded;
    const canonical = canonicalStackPlannedEffectManifestBytesV1(parsed);
    if (!canonical) {
      const row = record(parsed);
      if (row?.['schemaVersion'] !== 1 || row?.['protocol'] !== STACK_PLANNED_EFFECT_MANIFEST_PROTOCOL ||
        unsupportedSourceVersion(row?.['source'])) return fail('unsupported-version');
      if (row && exactKeys(row, MANIFEST_KEYS)) {
        if (!validEffect(row['effect'])) return fail('invalid-effect');
        if (!validCost(row['estimatedCost'])) return fail('invalid-cost');
        if (!validRollback(row['rollback'])) return fail('invalid-rollback');
      }
      return fail('invalid-manifest');
    }
    if (!canonical.equals(copied)) return fail('non-canonical-json');
    const manifest = parsed as StackPlannedEffectManifestV1;
    const generatedAt = Date.parse(manifest.generatedAt);
    const expiresAt = Date.parse(manifest.expiresAt);
    if (generatedAt > now.getTime() + STACK_PLANNED_EFFECT_MAX_FUTURE_SKEW_MS) return fail('future-manifest');
    if (expiresAt <= generatedAt || expiresAt - generatedAt > STACK_PLANNED_EFFECT_MAX_LIFETIME_MS ||
      expiresAt <= now.getTime()) return fail('stale-manifest');
    const expectedDigest = stackPlannedEffectManifestDigestV1(manifest);
    if (!expectedDigest || !sameText(expectedDigest, manifest.manifestDigest)) return fail('manifest-digest-mismatch');
    return immutable({ ok: true, plan: planOf(manifest), issues: [] });
  } catch {
    return fail('invalid-bytes');
  }
}
