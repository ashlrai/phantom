import type { RoutingLabCommand, RoutingLabEvaluation, RoutingLabPreferenceProposal, RoutingLabView, RoutingLabWrite } from '../../../../core/proactive/routing-lab-types.js';
import type { ReleaseReadinessResult } from '../../../../core/proactive/release-readiness-types.js';
import { decodeCompanionWire, projectCompanionWire } from '../../../../core/proactive/coordination-wire.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import type { ProactiveResourceEvidenceResponse, ProactiveResourceEvidenceRow } from '../../../../core/proactive/resource-evidence-types.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const PLANNING_PATH = '/api/verse/proactive-agents/planning';
export const RESOURCE_EVIDENCE_KEY = 'verse-proactive-resource-evidence';
function text(value: unknown): value is string { return typeof value === 'string'; }
function nullableText(value: unknown): value is string | null { return value === null || text(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
function evidence(value: unknown): boolean { return typeof value === 'string' && ['current', 'stale', 'missing', 'invalid', 'conflict'].includes(value); }
function validResource(value: unknown): value is ProactiveResourceEvidenceRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProactiveResourceEvidenceRow;
  return text(row.resourceId) && text(row.label) && !!row.identity && text(row.identity.provider)
    && nullableText(row.identity.accountId) && nullableText(row.identity.agentId)
    && ['native-subscription', 'api', 'local', 'personal-agent', 'funding-pool'].includes(row.kind)
    && ['declared', 'observed-reference', 'unknown', 'conflict'].includes(row.identityState)
    && ['configured', 'observed', 'signed-out', 'unavailable', 'unknown'].includes(row.connectionState)
    && ['declared-unverified', 'adapter-reported', 'unknown'].includes(row.capabilityState) && strings(row.capabilityIds)
    && row.entitlementState === 'unknown' && ['adapter-reported', 'blocked', 'unverified', 'unknown'].includes(row.readinessState)
    && evidence(row.evidenceState) && text(row.source) && nullableText(row.asOf) && row.executionAuthorized === false && strings(row.notes)
    && Array.isArray(row.usageWindows) && row.usageWindows.every(window => !!window && text(window.id)
      && (window.usedPercent === null || Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)
      && nullableText(window.resetsAt) && nullableText(window.resetDescription) && typeof window.limitReached === 'boolean'
      && nullableText(window.observedAt) && evidence(window.evidenceState))
    && Array.isArray(row.credits) && row.credits.every(credit => !!credit && text(credit.poolId)
      && ['gifted-cloud', 'purchased-usage', 'subscription-allowance', 'native-credit', 'promotional-api'].includes(credit.kind)
      && nullableText(credit.amount) && nullableText(credit.total) && text(credit.unit) && text(credit.surface) && text(credit.source)
      && nullableText(credit.asOf) && nullableText(credit.expiresAt) && nullableText(credit.expiryDate)
      && ['upcoming', 'expired', 'unknown'].includes(credit.expiryState) && evidence(credit.evidenceState)
      && nullableText(credit.fundingProductId) && nullableText(credit.fundingAccountId) && ['declared', 'unknown'].includes(credit.eligibilityState)
      && strings(credit.eligibleSurfaces) && strings(credit.excludedSurfaces) && ['balance', 'purchase', 'grant'].includes(credit.recordKind) && nullableText(credit.receiptAmount))
    && !!row.cost && ['actual', 'estimated', 'unknown'].includes(row.cost.state)
    && (row.cost.value === null || Number.isFinite(row.cost.value) && row.cost.value >= 0)
    && nullableText(row.cost.currency) && nullableText(row.cost.units) && nullableText(row.cost.source)
    && nullableText(row.cost.asOf) && evidence(row.cost.evidenceState);
}
export const resourceEvidenceQuery: QueryDef<ProactiveResourceEvidenceResponse> = {
  key: RESOURCE_EVIDENCE_KEY,
  async fetch(signal) {
    const response = await apiGet<ProactiveResourceEvidenceResponse>(`${PLANNING_PATH}/resources`, signal);
    if (!response || response.schemaVersion !== 1 || response.executionAuthorized !== false || !text(response.sampledAt)
      || !['snapshot', 'missing', 'invalid'].includes(response.sourceState) || !strings(response.notes)
      || !Array.isArray(response.resources) || !response.resources.every(validResource)) throw new Error('Resource evidence is incompatible. Refresh or update Phantom.');
    return response;
  },
};

export interface ReleaseReadinessResponse {
  schemaVersion: 1; sourceState: 'missing' | 'snapshot' | 'invalid'; readiness: ReleaseReadinessResult | null;
  notes: string[]; releaseAuthorized: false;
}
export type PlanningCommand = Exclude<RoutingLabCommand, { kind: 'preview' }> | { kind: 'preview'; requestId: string; expectedRevision: number; taskId: string };
export const PLANNING_KEY = 'verse-proactive-planning-lab';
export const RELEASE_READINESS_KEY = 'verse-proactive-release-readiness';
function validEvaluation(value: unknown): value is RoutingLabEvaluation {
  if (!value || typeof value !== 'object') return false;
  const row = value as RoutingLabEvaluation;
  return text(row.id) && text(row.requestId) && ['preview', 'benchmark'].includes(row.kind)
    && ['fixture', 'shadow-readonly'].includes(row.mode) && ['uncertain', 'completed', 'aborted'].includes(row.status)
    && text(row.inputDigest) && text(row.snapshotDigest) && text(row.policyId) && text(row.modelId)
    && ['deterministic-only', 'offline-fixture'].includes(row.adapterMode) && text(row.createdAt) && nullableText(row.completedAt)
    && (row.localDurationMs === null || Number.isFinite(row.localDurationMs) && row.localDurationMs >= 0)
    && row.providerLatencyMs === null && row.executionAuthorized === false && strings(row.notes)
    && !!row.summary && ['total', 'evaluated', 'expected', 'passed', 'failed', 'coverage'].every(key => {
      const count = row.summary[key as keyof typeof row.summary]; return Number.isFinite(count) && count >= 0;
    }) && Array.isArray(row.cases) && row.cases.every(test => !!test && text(test.caseId) && text(test.taskDigest) && text(test.snapshotDigest)
      && nullableText(test.selectedResourceId) && nullableText(test.expectedResourceId) && nullableText(test.fallbackReason)
      && ['deterministic', 'fixture-advice', 'held', 'aborted'].includes(test.path) && (test.passed === null || typeof test.passed === 'boolean')
      && strings(test.notes) && Number.isFinite(test.localDurationMs) && test.localDurationMs >= 0 && test.providerLatencyMs === null
      && test.executionAuthorized === false && Array.isArray(test.candidates) && test.candidates.every(candidate => !!candidate
        && text(candidate.resourceId) && text(candidate.label) && ['planning-candidate', 'qualified-shadow-fixture', 'held'].includes(candidate.qualification)
        && strings(candidate.holds) && strings(candidate.matchedCapabilityIds) && ['fixture', 'shadow-readonly'].includes(candidate.sourceMode) && candidate.executionAuthorized === false));
}
function validProposal(value: unknown): value is RoutingLabPreferenceProposal {
  if (!value || typeof value !== 'object') return false;
  const row = value as RoutingLabPreferenceProposal;
  return text(row.id) && text(row.evaluationId) && text(row.resourceId) && text(row.reason)
    && ['proposed', 'withdrawn'].includes(row.state) && text(row.createdAt) && nullableText(row.withdrawnAt) && row.executionAuthorized === false;
}
export const planningQuery: QueryDef<RoutingLabView> = {
  key: PLANNING_KEY,
  async fetch(signal) {
    const view = decodeCompanionWire(await apiGet<unknown>(PLANNING_PATH, signal)) as RoutingLabView;
    if (!view || view.schemaVersion !== 1 || view.executionAuthorized !== false || !Number.isSafeInteger(view.revision) || view.revision < 0
      || !['healthy', 'missing', 'degraded'].includes(view.sourceState) || !Array.isArray(view.evaluations) || !view.evaluations.every(validEvaluation)
      || !Array.isArray(view.proposals) || !view.proposals.every(validProposal)) throw new Error('Offline planning records are incompatible. Refresh or update Phantom.');
    return view;
  },
};
function validReadiness(value: unknown): value is ReleaseReadinessResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ReleaseReadinessResult;
  return result.schemaVersion === 1 && !!result.binding && ['npm', 'website', 'desktop'].includes(result.binding.channel)
    && ['targetId', 'version', 'sourceRevision', 'artifactDigest', 'attemptId'].every(key => text(result.binding[key as keyof typeof result.binding]))
    && text(result.asOf) && ['ready-for-review', 'blocked', 'unknown'].includes(result.readiness) && typeof result.simulated === 'boolean'
    && ['source', 'published', 'installed', 'simulated'].includes(result.evidenceLayer) && strings(result.gaps)
    && result.releaseAuthorized === false && !!result.effects && ['publish', 'deploy', 'install', 'serviceMutation', 'permissionChange'].every(key => result.effects[key as keyof typeof result.effects] === false)
    && Array.isArray(result.gates) && result.gates.every(gate => !!gate && text(gate.id)
      && ['passed', 'blocked', 'unknown', 'simulated'].includes(gate.state) && text(gate.reason) && strings(gate.receiptIds));
}
export const releaseReadinessQuery: QueryDef<ReleaseReadinessResponse> = {
  key: RELEASE_READINESS_KEY,
  async fetch(signal) {
    const result = decodeCompanionWire(await apiGet<unknown>(`${PLANNING_PATH}/release`, signal)) as ReleaseReadinessResponse;
    if (!result || result.schemaVersion !== 1 || result.releaseAuthorized !== false || !['missing', 'snapshot', 'invalid'].includes(result.sourceState)
      || !strings(result.notes) || !(result.readiness === null || validReadiness(result.readiness))) throw new Error('Release readiness records are incompatible. Refresh or update Phantom.');
    return result;
  },
};
export async function recordPlanning(command: PlanningCommand): Promise<RoutingLabWrite> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = decodeCompanionWire(await apiPost<unknown>(PLANNING_PATH, projectCompanionWire(command), token)) as RoutingLabWrite;
  touchMutationHold(); invalidate(PLANNING_KEY);
  if (!result || result.executionAuthorized !== false || typeof result.ok !== 'boolean'
    || result.ok && (!['recorded', 'replayed'].includes(result.disposition) || !Number.isSafeInteger(result.revision) || result.revision < 0
      || !(result.evaluation === null || validEvaluation(result.evaluation)) || !(result.proposal === null || validProposal(result.proposal)))
    || !result.ok && !['invalid', 'conflict', 'held', 'unavailable', 'capacity'].includes(result.reason)) throw new Error('The offline record could not be confirmed. Retry the same request before starting another.');
  return result;
}
