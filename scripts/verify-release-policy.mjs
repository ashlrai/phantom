#!/usr/bin/env node

/**
 * Strict, authority-free verifier for a future versioned release policy.
 *
 * This module reads no repository, registry, GitHub, credential, service, or
 * runtime state beyond the one explicit policy path supplied by the caller.
 * A valid policy is evidence only; it cannot authorize any effect.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const MAX_POLICY_BYTES = 64 * 1024;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const REVISION_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export const RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION = 1;
export const RELEASE_SUCCESSOR_POLICY_AUTHORITY = Object.freeze({
  activate: false,
  dispatch: false,
  install: false,
  promote: false,
  providerEffects: false,
  publish: false,
});

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'policyId',
  'package',
  'release',
  'registry',
  'localVerification',
  'toolchain',
  'runtime',
  'authority',
];
const ARTIFACT_KEYS = ['version', 'releaseTag', 'revision', 'integrity'];

function fail(message) {
  throw new Error(`release successor policy: ${message}`);
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`);
  }
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    fail(`${label} contains a non-string key`);
  }
  const actual = ownKeys.toSorted();
  const expected = [...keys].toSorted();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys do not match the closed schema`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function exactArray(value, label, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}-${maximum} entries`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...Array(value.length).keys()].map(String).concat('length');
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${label} must be a dense array without extra properties`);
  }
  return value;
}

function exactString(value, label, pattern, maximumBytes = 256) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function version(value, label) {
  return exactString(value, label, VERSION_RE, 32);
}

function revision(value, label) {
  return exactString(value, label, REVISION_RE, 40);
}

function integrity(value, label) {
  return exactString(value, label, INTEGRITY_RE, 95);
}

function versionTuple(value) {
  return value.split('.').map((part) => BigInt(part));
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function sameArtifact(left, right) {
  return ARTIFACT_KEYS.every((key) => left[key] === right[key]);
}

function validateArtifact(value, label) {
  const artifact = exactRecord(value, ARTIFACT_KEYS, label);
  const artifactVersion = version(artifact.version, `${label}.version`);
  if (artifact.releaseTag !== `v${artifactVersion}`) {
    fail(`${label}.releaseTag must match its version`);
  }
  revision(artifact.revision, `${label}.revision`);
  integrity(artifact.integrity, `${label}.integrity`);
  return artifact;
}

function validateOrderedHistory(values, label, candidateVersion, rollbackVersion) {
  const observed = new Set();
  let priorVersion = null;
  for (const [index, item] of values.entries()) {
    const itemVersion = version(item.version, `${label}[${index}].version`);
    if (itemVersion === candidateVersion || itemVersion === rollbackVersion || observed.has(itemVersion)) {
      fail(`${label} versions must be unique and distinct from candidate and rollback`);
    }
    if (compareVersions(itemVersion, candidateVersion) >= 0) {
      fail(`${label} versions must predate the candidate`);
    }
    if (priorVersion !== null && compareVersions(priorVersion, itemVersion) >= 0) {
      fail(`${label} must be ordered by increasing version`);
    }
    observed.add(itemVersion);
    priorVersion = itemVersion;
  }
}

export function canonicalizeReleaseSuccessorPolicy(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeReleaseSuccessorPolicy(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) fail('canonical JSON keys must be strings');
    return `{${keys.toSorted().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        fail('canonical JSON accepts enumerable data properties only');
      }
      return `${JSON.stringify(key)}:${canonicalizeReleaseSuccessorPolicy(descriptor.value)}`;
    }).join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
}

export function validateReleaseSuccessorPolicy(value) {
  const policy = exactRecord(value, TOP_LEVEL_KEYS, 'policy');
  if (policy.schemaVersion !== RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION}`);
  }

  const packagePolicy = exactRecord(
    policy.package,
    ['name', 'version', 'releaseTag', 'tarballName', 'integrity'],
    'package',
  );
  if (packagePolicy.name !== '@ashlr/hub') fail('package.name must be @ashlr/hub');
  const candidateVersion = version(packagePolicy.version, 'package.version');
  if (policy.policyId !== `ashlr-release-successor-v1:${candidateVersion}`) {
    fail('policyId must match package.version');
  }
  if (packagePolicy.releaseTag !== `v${candidateVersion}`) {
    fail('package.releaseTag must match package.version');
  }
  if (packagePolicy.tarballName !== `ashlr-hub-${candidateVersion}.tgz`) {
    fail('package.tarballName must match package.version');
  }
  integrity(packagePolicy.integrity, 'package.integrity');

  const release = exactRecord(
    policy.release,
    ['distTag', 'requiredProtectedBranch', 'requiredFirstParentRevision', 'rollback'],
    'release',
  );
  if (release.distTag !== 'candidate') fail('release.distTag must be candidate');
  if (release.requiredProtectedBranch !== 'master') {
    fail('release.requiredProtectedBranch must be master');
  }
  revision(release.requiredFirstParentRevision, 'release.requiredFirstParentRevision');
  const rollback = exactRecord(
    release.rollback,
    ['version', 'releaseTag', 'revision', 'tree', 'integrity'],
    'release.rollback',
  );
  const rollbackVersion = version(rollback.version, 'release.rollback.version');
  if (rollback.releaseTag !== `v${rollbackVersion}`) {
    fail('release.rollback.releaseTag must match its version');
  }
  revision(rollback.revision, 'release.rollback.revision');
  revision(rollback.tree, 'release.rollback.tree');
  integrity(rollback.integrity, 'release.rollback.integrity');
  if (compareVersions(candidateVersion, rollbackVersion) <= 0) {
    fail('package.version must be newer than release.rollback.version');
  }

  const registry = exactRecord(
    policy.registry,
    ['url', 'baselineLatest', 'previousCandidate', 'quarantined', 'failedCandidates'],
    'registry',
  );
  if (registry.url !== 'https://registry.npmjs.org/') {
    fail('registry.url must be the canonical public npm registry');
  }
  const baseline = validateArtifact(registry.baselineLatest, 'registry.baselineLatest');
  const previous = validateArtifact(registry.previousCandidate, 'registry.previousCandidate');
  const rollbackArtifact = {
    version: rollback.version,
    releaseTag: rollback.releaseTag,
    revision: rollback.revision,
    integrity: rollback.integrity,
  };
  if (!sameArtifact(baseline, rollbackArtifact) || !sameArtifact(previous, rollbackArtifact)) {
    fail('registry baseline and previous candidate must equal the exact rollback artifact');
  }

  const quarantined = exactArray(registry.quarantined, 'registry.quarantined', 1, 16);
  for (const [index, item] of quarantined.entries()) {
    validateArtifact(item, `registry.quarantined[${index}]`);
  }
  validateOrderedHistory(quarantined, 'registry.quarantined', candidateVersion, rollbackVersion);

  const failedCandidates = exactArray(
    registry.failedCandidates,
    'registry.failedCandidates',
    1,
    16,
  );
  for (const [index, item] of failedCandidates.entries()) {
    const label = `registry.failedCandidates[${index}]`;
    const failed = exactRecord(item, [
      'version',
      'releaseTag',
      'tagRevision',
      'attemptReceiptSha256',
      'npmVersionAbsent',
      'githubReleaseAbsent',
    ], label);
    const failedVersion = version(failed.version, `${label}.version`);
    if (failed.releaseTag !== `v${failedVersion}`) {
      fail(`${label}.releaseTag must match its version`);
    }
    revision(failed.tagRevision, `${label}.tagRevision`);
    exactString(
      failed.attemptReceiptSha256,
      `${label}.attemptReceiptSha256`,
      SHA256_RE,
      64,
    );
    if (failed.npmVersionAbsent !== true || failed.githubReleaseAbsent !== true) {
      fail(`${label} absence declarations must be true`);
    }
  }
  validateOrderedHistory(failedCandidates, 'registry.failedCandidates', candidateVersion, rollbackVersion);

  const historyVersions = new Set(quarantined.map((entry) => entry.version));
  const historyRevisions = new Set([rollback.revision]);
  for (const item of quarantined) {
    if (historyRevisions.has(item.revision)) {
      fail('quarantined, failed, and rollback revisions must be disjoint');
    }
    historyRevisions.add(item.revision);
  }
  for (const failed of failedCandidates) {
    if (historyVersions.has(failed.version)) {
      fail('quarantined and failed candidate versions must be disjoint');
    }
    if (historyRevisions.has(failed.tagRevision)) {
      fail('quarantined, failed, and rollback revisions must be disjoint');
    }
    historyVersions.add(failed.version);
    historyRevisions.add(failed.tagRevision);
  }

  const localVerification = exactRecord(policy.localVerification, [
    'kind',
    'contractPath',
    'contractSha256',
    'requiredReceiptSchemaVersion',
  ], 'localVerification');
  if (localVerification.kind !== 'local-production-gate-v1') {
    fail('localVerification.kind must be local-production-gate-v1');
  }
  if (localVerification.contractPath !== 'ashlr.verify.json') {
    fail('localVerification.contractPath must be ashlr.verify.json');
  }
  if (![1, 2, 3].includes(localVerification.requiredReceiptSchemaVersion)) {
    fail('localVerification.requiredReceiptSchemaVersion must be 1, 2, or 3');
  }
  exactString(
    localVerification.contractSha256,
    'localVerification.contractSha256',
    SHA256_RE,
    64,
  );

  const toolchain = exactRecord(policy.toolchain, ['nodeVersion', 'npmVersion'], 'toolchain');
  const nodeVersion = version(toolchain.nodeVersion, 'toolchain.nodeVersion');
  const npmVersion = version(toolchain.npmVersion, 'toolchain.npmVersion');
  if (versionTuple(nodeVersion)[0] < 24n || versionTuple(npmVersion)[0] < 11n) {
    fail('toolchain must use Node 24+ and npm 11+');
  }

  const runtime = exactRecord(policy.runtime, [
    'candidateManifestSchemaVersion',
    'rollbackManifestSchemaVersions',
    'stoppedConsumerProtocol',
  ], 'runtime');
  const rollbackManifestSchemas = exactArray(
    runtime.rollbackManifestSchemaVersions,
    'runtime.rollbackManifestSchemaVersions',
    2,
    2,
  );
  if (runtime.candidateManifestSchemaVersion !== 3
    || rollbackManifestSchemas[0] !== 2
    || rollbackManifestSchemas[1] !== 3
    || runtime.stoppedConsumerProtocol !== 'runtime-activation-stopped-consumer-v2') {
    fail('runtime compatibility must preserve v3 candidates and exact v2/v3 rollback support');
  }

  const authority = exactRecord(policy.authority, [
    'kind',
    'publish',
    'promote',
    'install',
    'activate',
    'dispatch',
    'providerEffects',
  ], 'authority');
  if (authority.kind !== 'evidence-only'
    || Object.entries(RELEASE_SUCCESSOR_POLICY_AUTHORITY)
      .some(([key, expected]) => authority[key] !== expected)) {
    fail('authority must remain evidence-only with every effect false');
  }

  return policy;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function parseReleaseSuccessorPolicyBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_POLICY_BYTES) {
    fail(`policy bytes must contain 2-${MAX_POLICY_BYTES} bytes`);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('policy bytes must be valid UTF-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('policy bytes must contain one JSON document');
  }
  validateReleaseSuccessorPolicy(parsed);
  const canonicalBytes = Buffer.from(`${canonicalizeReleaseSuccessorPolicy(parsed)}\n`, 'utf8');
  if (!bytes.equals(canonicalBytes)) fail('policy bytes must be canonical JSON followed by one LF');
  return Object.freeze({
    policy: deepFreeze(parsed),
    canonicalSha256: createHash('sha256').update(canonicalBytes).digest('hex'),
  });
}

function parseCli(argv) {
  if (argv.length < 1 || argv.length > 4) fail('usage: verify-release-policy.mjs <path> [--expect-version <x.y.z>] [--json]');
  const result = { path: argv[0], expectedVersion: null, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--json' && result.json === false) {
      result.json = true;
    } else if (argv[index] === '--expect-version' && result.expectedVersion === null
      && index + 1 < argv.length) {
      result.expectedVersion = version(argv[index + 1], '--expect-version');
      index += 1;
    } else {
      fail('usage: verify-release-policy.mjs <path> [--expect-version <x.y.z>] [--json]');
    }
  }
  return result;
}

export function verifyReleaseSuccessorPolicyFile(path, expectedVersion = null) {
  const result = parseReleaseSuccessorPolicyBytes(readFileSync(path));
  if (expectedVersion !== null && result.policy.package.version !== expectedVersion) {
    fail('package.version does not match --expect-version');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Release-path policy v2: one static policy for every release on the live
// publisher path. It carries no per-version integrity: the published bytes are
// checked against the integrity the registry reports for the version just
// published. The caller supplies read-only evidence files (registry version
// document, registry attestations, the admitted archive, the tag ref and the
// qualifying CI run); this module still performs no network or process effect.
export const RELEASE_PATH_POLICY_SCHEMA_VERSION = 2;
const RELEASE_PATH_POLICY_KEYS = [
  'schemaVersion', 'policyId', 'packages', 'repository', 'protectedBranch',
  'publisherWorkflowPath', 'candidateSource', 'ciAppId', 'registry', 'provenancePredicateType', 'authority',
];
const PACKAGE_NAME_RE = /^@ashlr\/[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

function parseCanonicalJsonBytes(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_POLICY_BYTES) {
    fail(`${label} must contain 2-${MAX_POLICY_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} must be one UTF-8 JSON document`);
  }
  return parsed;
}

export function validateReleasePathPolicy(value) {
  const policy = exactRecord(value, RELEASE_PATH_POLICY_KEYS, 'policy');
  if (policy.schemaVersion !== RELEASE_PATH_POLICY_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${RELEASE_PATH_POLICY_SCHEMA_VERSION}`);
  }
  if (policy.policyId !== 'ashlr-release-path-v2') fail('policyId must be ashlr-release-path-v2');
  const packages = exactArray(policy.packages, 'packages', 1, 8);
  const seen = new Set();
  for (const [index, name] of packages.entries()) {
    exactString(name, `packages[${index}]`, PACKAGE_NAME_RE, 72);
    if (seen.has(name)) fail('packages must not repeat');
    seen.add(name);
  }
  if (policy.repository !== 'https://github.com/ashlrai/phantom') {
    fail('repository must be https://github.com/ashlrai/phantom');
  }
  if (policy.protectedBranch !== 'master') fail('protectedBranch must be master');
  exactString(policy.publisherWorkflowPath, 'publisherWorkflowPath', /^\.github\/[a-z/-]+\.yml$/u, 96);
  if (policy.candidateSource !== 'merged-protected-branch-commit') {
    fail('candidateSource must be merged-protected-branch-commit');
  }
  if (policy.ciAppId !== 15368) fail('ciAppId must be 15368 (GitHub Actions)');
  if (policy.registry !== 'https://registry.npmjs.org/') {
    fail('registry must be the canonical public npm registry');
  }
  if (policy.provenancePredicateType !== 'https://slsa.dev/provenance/v1') {
    fail('provenancePredicateType must be https://slsa.dev/provenance/v1');
  }
  const authority = exactRecord(
    policy.authority,
    ['kind', ...Object.keys(RELEASE_SUCCESSOR_POLICY_AUTHORITY)],
    'authority',
  );
  if (authority.kind !== 'evidence-only') fail('authority.kind must be evidence-only');
  for (const key of Object.keys(RELEASE_SUCCESSOR_POLICY_AUTHORITY)) {
    if (authority[key] !== false) fail(`authority.${key} must be false`);
  }
  return policy;
}

export function parseReleasePathPolicyBytes(bytes) {
  const parsed = parseCanonicalJsonBytes(bytes, 'policy bytes');
  validateReleasePathPolicy(parsed);
  const canonicalBytes = Buffer.from(`${canonicalizeReleaseSuccessorPolicy(parsed)}\n`, 'utf8');
  if (!bytes.equals(canonicalBytes)) fail('policy bytes must be canonical JSON followed by one LF');
  return Object.freeze({
    policy: deepFreeze(parsed),
    canonicalSha256: createHash('sha256').update(canonicalBytes).digest('hex'),
  });
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function npmPurl(name, packageVersion) {
  return `pkg:npm/${name.replace('@', '%40')}@${packageVersion}`;
}

// Pure check of one published release against the v2 policy. evidence:
// { versionDocument, attestations, tarball (Buffer), tagRef, requiredChecks, checkRuns, compare, candidateRevision }
export function verifyPublishedRelease(policy, evidence) {
  validateReleasePathPolicy(policy);
  const doc = record(evidence.versionDocument, 'registry version document');
  if (!policy.packages.includes(doc.name)) fail('published package is not in the policy allowlist');
  const publishedVersion = version(doc.version, 'registry version');
  const candidate = revision(evidence.candidateRevision, 'candidate revision');
  const dist = record(doc.dist, 'registry dist');
  const registryIntegrity = integrity(dist.integrity, 'registry dist.integrity');

  if (!Buffer.isBuffer(evidence.tarball) || evidence.tarball.length < 1 || evidence.tarball.length > MAX_EVIDENCE_BYTES) {
    fail('admitted archive bytes are missing');
  }
  const digest = createHash('sha512').update(evidence.tarball);
  const archiveHex = digest.copy().digest('hex');
  const archiveIntegrity = `sha512-${digest.digest('base64')}`;
  if (archiveIntegrity !== registryIntegrity) fail('admitted archive integrity differs from the registry-reported integrity');

  const declared = record(record(dist.attestations, 'registry dist.attestations').provenance, 'registry provenance');
  if (declared.predicateType !== policy.provenancePredicateType) fail('registry does not declare SLSA v1 provenance');
  const bundles = exactArray(record(evidence.attestations, 'attestations').attestations, 'attestations', 1, 8);
  const slsa = bundles.filter((item) => record(item, 'attestation').predicateType === policy.provenancePredicateType);
  if (slsa.length !== 1) fail('exactly one SLSA provenance attestation is required');
  let statement;
  try {
    statement = JSON.parse(Buffer.from(slsa[0].bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  } catch {
    fail('provenance statement could not be decoded');
  }
  const subjects = exactArray(record(statement, 'provenance statement').subject, 'provenance subject', 1, 1);
  if (subjects[0].name !== npmPurl(doc.name, publishedVersion)) fail('provenance subject names a different package');
  if (record(subjects[0].digest, 'provenance digest').sha512 !== archiveHex) fail('provenance subject digest differs from the archive');
  const workflow = record(record(record(record(statement.predicate, 'predicate').buildDefinition, 'buildDefinition')
    .externalParameters, 'externalParameters').workflow, 'provenance workflow');
  if (workflow.repository !== policy.repository) fail('provenance repository differs from policy');
  if (workflow.path !== policy.publisherWorkflowPath) fail('provenance workflow is not the policy publisher');
  if (workflow.ref !== `refs/heads/${policy.protectedBranch}`) fail('provenance workflow ref is not the protected branch');

  const tagRef = record(evidence.tagRef, 'tag ref');
  if (tagRef.ref !== `refs/tags/v${publishedVersion}`) fail('release tag must be v<published version>');
  const tagObject = record(tagRef.object, 'tag ref object');
  if (tagObject.type !== 'commit' || tagObject.sha !== candidate) fail('release tag must point directly at the candidate revision');

  verifyCandidateOnProtectedBranch(evidence.compare);
  const ci = verifyRequiredChecks(policy, evidence.requiredChecks, evidence.checkRuns);

  return Object.freeze({
    ok: true,
    schemaVersion: RELEASE_PATH_POLICY_SCHEMA_VERSION,
    package: doc.name,
    version: publishedVersion,
    releaseTag: `v${publishedVersion}`,
    candidateRevision: candidate,
    integrity: registryIntegrity,
    provenance: policy.provenancePredicateType,
    requiredChecks: ci,
    authority: RELEASE_SUCCESSOR_POLICY_AUTHORITY,
  });
}

// The publisher releases only a merged commit of the protected branch, never a
// PR head. Evidence is the compare API result for <protectedBranch>...<candidate>:
// "identical" (candidate is the tip) or "behind" (candidate is an ancestor).
export function verifyCandidateOnProtectedBranch(compare) {
  const status = record(compare, 'compare result').status;
  if (status !== 'identical' && status !== 'behind') {
    fail(`candidate revision is not a merged commit of the protected branch (compare status: ${typeof status === 'string' ? status : 'unknown'})`);
  }
  return status;
}

// Green CI on the exact release SHA, from check runs the caller looked up for
// that SHA (never a caller-chosen run id). Only GitHub Actions runs
// (policy.ciAppId) from a merge_group event or a push to the protected branch
// count. Every required name must be present among counted runs, and every
// counted run with that name must be completed + success.
export function verifyRequiredChecks(policy, requiredChecks, checkRuns) {
  const required = exactArray(requiredChecks, 'required checks', 1, 32);
  const runs = exactArray(checkRuns, 'check runs', 0, 512);
  const counted = runs.filter((run) => {
    const item = record(run, 'check run');
    return item.appId === policy.ciAppId
      && (item.event === 'merge_group'
        || (item.event === 'push' && item.headBranch === policy.protectedBranch));
  });
  const names = [];
  for (const [index, name] of required.entries()) {
    exactString(name, `required checks[${index}]`, /^[^\n]{1,128}$/u, 256);
    const same = counted.filter((run) => run.name === name);
    if (same.length === 0) fail(`required check missing on the release revision: ${name}`);
    for (const run of same) {
      if (run.status !== 'completed' || run.conclusion !== 'success') {
        fail(`required check not green on the release revision: ${name}`);
      }
    }
    names.push(name);
  }
  return Object.freeze(names);
}

const RELEASE_PATH_USAGE = 'usage: verify-release-policy.mjs --release-path <policy> --version-document <json> --attestations <json> --tarball <tgz> --tag-ref <json> --checks <json> --compare <json> --candidate <sha>';

function releasePathMain(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined || flags.has(argv[index])) fail(RELEASE_PATH_USAGE);
    flags.set(argv[index], argv[index + 1]);
  }
  const need = ['--release-path', '--version-document', '--attestations', '--tarball', '--tag-ref', '--checks', '--compare', '--candidate'];
  if (flags.size !== need.length || need.some((key) => !flags.has(key))) fail(RELEASE_PATH_USAGE);
  const json = (key) => parseCanonicalJsonBytes(readFileSync(flags.get(key)), key);
  const { policy, canonicalSha256 } = parseReleasePathPolicyBytes(readFileSync(flags.get('--release-path')));
  const receipt = verifyPublishedRelease(policy, {
    versionDocument: JSON.parse(readFileSync(flags.get('--version-document'), 'utf8')),
    attestations: JSON.parse(readFileSync(flags.get('--attestations'), 'utf8')),
    tarball: readFileSync(flags.get('--tarball')),
    tagRef: json('--tag-ref'),
    compare: JSON.parse(readFileSync(flags.get('--compare'), 'utf8')),
    ...(() => {
      const checks = record(JSON.parse(readFileSync(flags.get('--checks'), 'utf8')), '--checks');
      return { requiredChecks: checks.requiredChecks, checkRuns: checks.checkRuns };
    })(),
    candidateRevision: flags.get('--candidate'),
  });
  process.stdout.write(`${JSON.stringify({ ...receipt, policySha256: canonicalSha256 })}\n`);
}

function main() {
  if (process.argv[2] === '--release-path') {
    releasePathMain(process.argv.slice(2));
    return;
  }
  const options = parseCli(process.argv.slice(2));
  const result = verifyReleaseSuccessorPolicyFile(options.path, options.expectedVersion);
  const receipt = {
    ok: true,
    schemaVersion: RELEASE_SUCCESSOR_POLICY_SCHEMA_VERSION,
    policyId: result.policy.policyId,
    version: result.policy.package.version,
    releaseTag: result.policy.package.releaseTag,
    canonicalSha256: result.canonicalSha256,
    authority: RELEASE_SUCCESSOR_POLICY_AUTHORITY,
  };
  process.stdout.write(options.json
    ? `${JSON.stringify(receipt)}\n`
    : `${receipt.canonicalSha256}  ${receipt.policyId}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'release successor policy: failed'}\n`);
    process.exitCode = 1;
  }
}
