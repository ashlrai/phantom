/** Pure release evidence preview. No filesystem, provider, publisher or authority calls. */
import type {
  ReleaseBinding, ReleaseEvidenceKind, ReleaseEvidenceReceipt, ReleaseReadinessGate,
  ReleaseReadinessHost, ReleaseReadinessInput, ReleaseReadinessResult,
} from './release-readiness-types.js';
import {
  canonicalJson, hasNoControlChars, isCanonicalIsoTimestamp, isDenseDataArray, isPlainDataObject, isSha256Hex,
} from './validation.js';

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-zA-Z0-9.-]+)?$/;
const KINDS: readonly ReleaseEvidenceKind[] = ['tests', 'qualification', 'provenance', 'commissioning', 'provider-status', 'replay'];
const emptyBinding: ReleaseBinding = {channel: 'npm', targetId: '', version: '', sourceRevision: '', artifactDigest: '', attemptId: ''};
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && hasNoControlChars(value);
}
/** Copy data properties only; callbacks cannot change the remaining evaluation inputs. */
function snapshot(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('projection nesting exceeds limit');
  if (value === null || ['string', 'boolean', 'number', 'undefined'].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    if (!isDenseDataArray(value, 256)) throw new Error('invalid projection array');
    return Array.from({length: value.length}, (_, i) => snapshot(value[i], depth + 1));
  }
  if (!isPlainDataObject(value, {maxKeys: 32})) throw new Error('invalid projection object');
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, property]) => [key, snapshot(property.value, depth + 1)]));
}
function validBinding(value: unknown): value is ReleaseBinding {
  return isPlainDataObject(value) && ['npm', 'website', 'desktop'].includes(String(value.channel)) && text(value.targetId) &&
    text(value.version, 128) && (value.channel === 'website' || VERSION.test(value.version)) &&
    typeof value.sourceRevision === 'string' && SHA.test(value.sourceRevision) &&
    isSha256Hex(value.artifactDigest) && text(value.attemptId);
}
function sameBinding(a: ReleaseBinding, b: ReleaseBinding): boolean {
  return a.channel === b.channel && a.targetId === b.targetId && a.version === b.version &&
    a.sourceRevision === b.sourceRevision && a.artifactDigest === b.artifactDigest && a.attemptId === b.attemptId;
}
function strings(value: unknown, max = 32): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(v => text(v, 512)) && new Set(value).size === value.length;
}
function validReceipt(value: unknown): value is ReleaseEvidenceReceipt {
  return isPlainDataObject(value) && text(value.id) && KINDS.includes(value.kind as ReleaseEvidenceKind) && validBinding(value.binding) &&
    ['local-readonly', 'host-observed', 'fixture', 'declared'].includes(String(value.source)) &&
    ['passed', 'failed', 'unknown', 'revoked'].includes(String(value.status)) && isCanonicalIsoTimestamp(value.observedAt) && isCanonicalIsoTimestamp(value.expiresAt) &&
    Date.parse(value.expiresAt) > Date.parse(value.observedAt) && text(value.reference, 512) &&
    (value.providerState === undefined || ['not-contacted', 'available', 'published', 'installed', 'unknown', 'failed'].includes(String(value.providerState))) &&
    (value.replayState === undefined || ['unconsumed', 'consumed', 'unknown'].includes(String(value.replayState))) &&
    (value.scopeRevision === undefined || text(value.scopeRevision));
}
function gate(id: string, state: ReleaseReadinessGate['state'], reason: string, receiptIds: string[] = []): ReleaseReadinessGate {
  return {id, state, reason, receiptIds};
}
function evidenceGate(kind: ReleaseEvidenceKind, receipts: ReleaseEvidenceReceipt[], binding: ReleaseBinding, asOf: string,
  host: ReleaseReadinessHost | undefined): ReleaseReadinessGate {
  const rows = receipts.filter(r => r.kind === kind);
  if (!rows.length) return gate(kind, 'unknown', `No ${kind} receipt is available.`);
  const ids = rows.map(r => r.id);
  if (rows.some(r => !sameBinding(r.binding, binding))) return gate(kind, 'blocked', 'Receipt target, version, source, artifact or attempt does not match.', ids);
  if (rows.some(r => r.status === 'failed' || r.status === 'revoked')) return gate(kind, 'blocked', 'Evidence failed or its scope was revoked.', ids);
  if (rows.some(r => Date.parse(r.observedAt) > Date.parse(asOf) || Date.parse(r.expiresAt) <= Date.parse(asOf))) {
    return gate(kind, 'blocked', 'Evidence is stale or from the future.', ids);
  }
  if (kind === 'provider-status' && rows.some(r => !r.providerState || r.providerState === 'unknown' || r.providerState === 'failed')) {
    return gate(kind, 'blocked', 'Provider state is unresolved; reconcile before another write.', ids);
  }
  if (kind === 'provider-status' && new Set(rows.map(r => r.providerState)).size > 1) return gate(kind, 'blocked', 'Provider state observations conflict; reconcile before another write.', ids);
  if (kind === 'replay' && rows.some(r => r.replayState !== 'unconsumed')) {
    return gate(kind, 'blocked', 'Attempt is consumed or replay state is unresolved.', ids);
  }
  if (kind === 'commissioning' && rows.some(r => !r.scopeRevision)) return gate(kind, 'unknown', 'Exact commissioning scope revision is missing.', ids);
  if (rows.some(r => r.status === 'unknown' || r.source === 'declared')) return gate(kind, 'unknown', 'A declaration is not verified evidence.', ids);
  let simulated = false;
  for (const receipt of rows) {
    if (receipt.source === 'fixture') { simulated = true; continue; }
    if (receipt.source === 'local-readonly') {
      if (kind !== 'tests') return gate(kind, 'unknown', 'Local evidence does not qualify a commissioned release target.', ids);
      continue;
    }
    if (!host) return gate(kind, 'unknown', 'Host verification is unavailable; JSON cannot attest trusted evidence.', ids);
    let disposition: ReturnType<ReleaseReadinessHost['verifyEvidence']>;
    try {
      const snapshot = Object.freeze({...receipt, binding: Object.freeze({...receipt.binding})});
      disposition = host.verifyEvidence(snapshot, Object.freeze({...binding}), asOf);
    } catch { disposition = 'unavailable'; }
    if (disposition === 'revoked' || disposition === 'invalid') return gate(kind, 'blocked', 'Independent host validation rejected or revoked this evidence.', ids);
    if (disposition !== 'verified') return gate(kind, 'unknown', 'Independent host validation is unavailable.', ids);
  }
  return gate(kind, simulated ? 'simulated' : 'passed', simulated ? 'Fixture evidence only; no live qualification.' : 'Bound, fresh read-only evidence passed.', ids);
}
function newerVersion(next: string, current: string): boolean {
  if (!VERSION.test(next) || next.includes('-') || current.includes('-')) return false;
  const a = next.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (a[i]! > b[i]!) return true; if (a[i]! < b[i]!) return false; }
  return false;
}
function recoveryGate(input: ReleaseReadinessInput): ReleaseReadinessGate {
  const plan = input.recovery;
  if (!plan) return gate('recovery', 'unknown', 'No channel-specific recovery plan is supplied.');
  if (!isPlainDataObject(plan) || !validBinding(plan.binding) || !sameBinding(plan.binding, input.binding) || plan.channel !== input.binding.channel || !text(plan.ownerId)) {
    return gate('recovery', 'blocked', 'Recovery plan does not bind the exact release and responsible owner.');
  }
  if (plan.channel === 'npm') {
    if (!['corrective-version', 'deprecate-and-correct'].includes(plan.strategy) || plan.overwritePublishedVersion !== false ||
        !text(plan.correctiveVersion) || !newerVersion(plan.correctiveVersion, input.binding.version)) {
      return gate('recovery', 'blocked', 'npm recovery requires a newer corrective version; immutable versions cannot be overwritten.');
    }
  } else if (plan.channel === 'website') {
    if (plan.strategy !== 'restore-deployment' || !text(plan.previousDeploymentId) || !strings(plan.affectedTargets) || !plan.affectedTargets.includes(input.binding.targetId)) {
      return gate('recovery', 'blocked', 'Website recovery must pin the prior deployment and include the exact affected target.');
    }
  } else if (plan.strategy !== 'signed-recovery-update' || !isSha256Hex(plan.previousSignedInstallerDigest) ||
      plan.previousSignedInstallerDigest === input.binding.artifactDigest ||
      !text(plan.updateChannel) || !text(plan.customerUpdatePath, 512) || !strings(plan.compatibilityChecks)) {
    return gate('recovery', 'blocked', 'Desktop recovery must name a distinct prior signed installer, update channel, customer update path and compatibility checks.');
  }
  return gate('recovery', 'passed', 'Channel-specific recovery plan is bound; execution and recovery remain unauthorized.');
}
/** Evaluate only supplied projections at an explicit time. This result must never be used as a release grant. */
export function evaluateReleaseReadiness(input: ReleaseReadinessInput, host?: ReleaseReadinessHost): ReleaseReadinessResult {
  const gates: ReleaseReadinessGate[] = [];
  let binding = {...emptyBinding};
  let asOf = '';
  let simulated = false;
  let evidenceLayer: ReleaseReadinessResult['evidenceLayer'] = 'source';
  try {
    input = snapshot(input) as ReleaseReadinessInput;
    if (!isPlainDataObject(input) || !validBinding(input.binding) || !isCanonicalIsoTimestamp(input.asOf) ||
        ![true, false, null].includes(input.sourceClean) || !Array.isArray(input.evidence) || input.evidence.length > 64 || !input.evidence.every(validReceipt)) {
      gates.push(gate('input', 'blocked', 'Release binding, time or receipt projection is invalid.'));
    } else {
      binding = {...input.binding}; asOf = input.asOf;
      // Detach from caller and validator mutation; this evaluator never retains input references.
      const evidence = input.evidence.map(r => ({...r, binding: {...r.binding}}));
      simulated = evidence.some(r => r.source === 'fixture');
      const seen = new Map<string, string>();
      let conflict = false;
      const unique = evidence.filter(r => {
        const value = canonicalJson(r);
        if (seen.has(r.id)) { if (seen.get(r.id) !== value) conflict = true; return false; }
        seen.set(r.id, value); return true;
      });
      gates.push(gate('receipt-identity', conflict ? 'blocked' : 'passed', conflict ? 'One receipt ID has conflicting projections.' : 'Receipt identities are consistent.'));
      gates.push(gate('source-clean', input.sourceClean === false ? 'blocked' : input.sourceClean === null ? 'unknown' : 'passed',
        input.sourceClean === false ? 'Source contains unqualified edits.' : input.sourceClean === null ? 'Source cleanliness is unknown.' : 'Exact source is reported clean.'));
      for (const kind of KINDS) gates.push(evidenceGate(kind, unique, binding, asOf, host));
      const checks = input.postChecks;
      gates.push(!checks ? gate('post-checks', 'unknown', 'No post-release acceptance plan is supplied.') :
        !isPlainDataObject(checks) || !validBinding(checks.binding) || !sameBinding(checks.binding, binding) || !strings(checks.checks) ||
        !text(checks.ownerId) || !isCanonicalIsoTimestamp(checks.deadlineAt) || Date.parse(checks.deadlineAt) <= Date.parse(asOf) ?
          gate('post-checks', 'blocked', 'Post-checks must bind this release, an owner, checks and a future deadline.') :
          gate('post-checks', 'passed', 'Post-release checks are planned; they have not been executed.'));
      gates.push(recoveryGate(input));
      const providerGate = gates.find(g => g.id === 'provider-status');
      if (providerGate?.state === 'passed') {
        const states = unique.filter(r => r.kind === 'provider-status').map(r => r.providerState);
        if (states.includes('installed')) evidenceLayer = 'installed';
        else if (states.includes('published')) evidenceLayer = 'published';
      }
    }
  } catch { gates.push(gate('input', 'blocked', 'Release projection could not be safely evaluated.')); }
  if (simulated) evidenceLayer = 'simulated';
  const readiness = gates.some(g => g.state === 'blocked') ? 'blocked' : gates.some(g => g.state === 'unknown') ? 'unknown' : 'ready-for-review';
  return {schemaVersion: 1, binding, asOf, readiness, simulated, evidenceLayer, gates,
    gaps: gates.filter(g => g.state !== 'passed').map(g => `${g.id}: ${g.reason}`), releaseAuthorized: false,
    effects: {publish: false, deploy: false, install: false, serviceMutation: false, permissionChange: false}};
}
