/** Fleet status: dispatch yield. Internal to status.ts. */

import type {
  AshlrConfig,
  EngineTier,
} from '../types.js';
import type {
  DispatchProductionYieldSummary,
  DispatchProductionYieldBucket,
} from './dispatch-production-ledger.js';
import {
  isSuppressedProposalProductionReason,
} from './status-production.js';
import type {
  FleetDispatchYieldDiagnosticVerdict,
  FleetDispatchYieldDiagnosticAction,
  FleetBackendStatus,
  FleetDispatchYieldDiagnosticCandidate,
  FleetDispatchYieldDiagnostics,
} from './status-types.js';
import {
  engineInstalled,
} from '../run/engines.js';
import {
  engineTierOf,
} from '../run/sandboxed-engine.js';

const MIN_DISPATCH_YIELD_ACTION_ATTEMPTS = 3;

const LOW_DISPATCH_YIELD_ACTION_RATE = 0.2;

function configuredLowDispatchYieldRate(cfg: AshlrConfig): number {
  const raw = cfg.foundry?.intelligence?.minProposalYieldRate;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return LOW_DISPATCH_YIELD_ACTION_RATE;
  return Math.max(0, Math.min(1, raw));
}

function formatActionPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}

function diagnosticPolicyDisabled(
  value: Pick<DispatchProductionYieldSummary, 'outcomes' | 'attemptShape'>,
): number {
  const classified = value.attemptShape?.policyDisabled;
  if (classified !== undefined && Number.isFinite(classified)) {
    return Math.max(0, Math.floor(classified));
  }
  return Math.max(0, value.outcomes.proposalDisabled);
}

function diagnosticCancelled(
  value: Pick<DispatchProductionYieldSummary, 'outcomes'>,
): number {
  return value.outcomes.cancelled ?? 0;
}

function diagnosticAttemptsForDispatchBucket(bucket: DispatchProductionYieldBucket): number {
  if (bucket.diagnosticAttempts !== undefined && Number.isFinite(bucket.diagnosticAttempts)) {
    return Math.max(0, Math.floor(bucket.diagnosticAttempts));
  }
  return Math.max(0, bucket.attempts - diagnosticPolicyDisabled(bucket) - diagnosticCancelled(bucket));
}

function diagnosticAttemptsForDispatchSummary(summary: DispatchProductionYieldSummary): number {
  if (summary.diagnosticAttempts !== undefined && Number.isFinite(summary.diagnosticAttempts)) {
    return Math.max(0, Math.floor(summary.diagnosticAttempts));
  }
  return Math.max(0, summary.attempts - diagnosticPolicyDisabled(summary) - diagnosticCancelled(summary));
}

function diagnosticNoProposalForDispatchBucket(
  bucket: DispatchProductionYieldBucket,
  diagnosticAttempts: number,
): number {
  if (bucket.diagnosticNoProposal !== undefined && Number.isFinite(bucket.diagnosticNoProposal)) {
    return Math.max(0, Math.floor(bucket.diagnosticNoProposal));
  }
  return Math.max(0, diagnosticAttempts - bucket.proposalsCreated);
}

function diagnosticNoProposalForDispatchSummary(
  summary: DispatchProductionYieldSummary,
  diagnosticAttempts: number,
): number {
  if (summary.diagnosticNoProposal !== undefined && Number.isFinite(summary.diagnosticNoProposal)) {
    return Math.max(0, Math.floor(summary.diagnosticNoProposal));
  }
  return Math.max(0, diagnosticAttempts - summary.proposalsCreated);
}

function diagnosticTopReason(bucket: DispatchProductionYieldBucket): string | undefined {
  if (bucket.diagnosticTopReasons !== undefined) {
    return bucket.diagnosticTopReasons[0]?.reason;
  }
  return bucket.topReasons.find((reason) => !isSuppressedProposalProductionReason(reason.reason))?.reason;
}

function diagnosticTopReasonForDispatchSummary(summary: DispatchProductionYieldSummary): string | undefined {
  if (summary.diagnosticTopReasons !== undefined) {
    return summary.diagnosticTopReasons[0]?.reason;
  }
  return summary.topReasons.find((reason) => !isSuppressedProposalProductionReason(reason.reason))?.reason;
}

function dispatchYieldVerdict(
  diagnosticAttempts: number,
  proposalRate: number,
  policyDisabled: number,
  lowYieldRate: number,
): FleetDispatchYieldDiagnosticVerdict {
  if (diagnosticAttempts === 0 && policyDisabled > 0) return 'policy-suppressed';
  if (
    diagnosticAttempts < MIN_DISPATCH_YIELD_ACTION_ATTEMPTS ||
    !Number.isFinite(proposalRate)
  ) {
    return 'insufficient-sample';
  }
  return proposalRate < lowYieldRate ? 'actionable' : 'healthy';
}

function dispatchYieldActionFor(
  verdict: FleetDispatchYieldDiagnosticVerdict,
  shape: DispatchProductionYieldSummary['attemptShape'],
): FleetDispatchYieldDiagnosticAction {
  if (verdict === 'insufficient-sample') return 'collect-more-samples';
  if (verdict !== 'actionable') return 'keep-routing';
  const noDiff = shape?.backendNoDiff ?? 0;
  const gate = shape?.captureOrGateBlocked ?? 0;
  return noDiff > 0 && noDiff >= gate
    ? 'route-same-tier-alternative'
    : 'tighten-context-or-reslice';
}

function dispatchYieldHasTrustedCapacity(backend: FleetBackendStatus): boolean {
  const availability = backend.resource?.availability;
  return availability === 'open';
}

function dispatchYieldInstalledForStatus(backend: FleetBackendStatus, cfg: AshlrConfig): boolean {
  if (backend.backend === 'builtin') return false;
  if (backend.backend === 'local-coder' && dispatchYieldHasTrustedCapacity(backend)) {
    return true;
  }
  try {
    return engineInstalled(backend.backend, cfg);
  } catch {
    return false;
  }
}

function hasDispatchYieldSameTierAlternative(
  candidate: FleetDispatchYieldDiagnosticCandidate,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): boolean {
  if (!candidate.backend) return false;
  let currentTier: EngineTier;
  try {
    currentTier = engineTierOf(candidate.backend, cfg);
  } catch {
    return false;
  }
  for (const backend of backends) {
    if (backend.backend === candidate.backend) continue;
    if (backend.backend === 'builtin') continue;
    if (!dispatchYieldHasTrustedCapacity(backend)) continue;
    try {
      if (engineTierOf(backend.backend, cfg) !== currentTier) continue;
    } catch {
      continue;
    }
    if (!dispatchYieldInstalledForStatus(backend, cfg)) continue;
    return true;
  }
  return false;
}

function effectiveDispatchYieldCandidate(
  candidate: FleetDispatchYieldDiagnosticCandidate,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): FleetDispatchYieldDiagnosticCandidate {
  if (candidate.action !== 'route-same-tier-alternative') return candidate;
  if (hasDispatchYieldSameTierAlternative(candidate, cfg, backends)) return candidate;
  return {
    ...candidate,
    action: 'tighten-context-or-reslice',
    actionReason: 'no open installed same-tier alternative is available',
  };
}

function dispatchYieldCandidate(
  bucket: DispatchProductionYieldBucket,
  scope: FleetDispatchYieldDiagnosticCandidate['scope'],
  lowYieldRate: number,
): FleetDispatchYieldDiagnosticCandidate {
  const diagnosticAttempts = diagnosticAttemptsForDispatchBucket(bucket);
  const proposalsCreated = bucket.proposalsCreated;
  const proposalRate = diagnosticAttempts > 0 ? proposalsCreated / diagnosticAttempts : 0;
  const policyDisabled = diagnosticPolicyDisabled(bucket);
  const verdict = dispatchYieldVerdict(diagnosticAttempts, proposalRate, policyDisabled, lowYieldRate);
  return {
    scope,
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    diagnosticAttempts,
    proposalsCreated,
    noProposal: diagnosticNoProposalForDispatchBucket(bucket, diagnosticAttempts),
    proposalRate,
    policyDisabled,
    verdict,
    action: dispatchYieldActionFor(verdict, bucket.attemptShape),
    sameTierOnly: true,
    ...(diagnosticTopReason(bucket) ? { topReason: diagnosticTopReason(bucket) } : {}),
    ...(bucket.attemptShape ? { attemptShape: bucket.attemptShape } : {}),
    ...(bucket.generatedRepairAttempts ? { generatedRepairAttempts: bucket.generatedRepairAttempts } : {}),
  };
}

function dispatchYieldSubject(candidate: FleetDispatchYieldDiagnosticCandidate): string {
  if (candidate.backend && candidate.source) return `${candidate.backend}/${candidate.source}`;
  if (candidate.backend) return candidate.backend;
  return candidate.key === 'fleet' ? 'dispatches' : candidate.key;
}

function sortDispatchYieldCandidates(
  candidates: FleetDispatchYieldDiagnosticCandidate[],
): FleetDispatchYieldDiagnosticCandidate[] {
  const verdictRank: Record<FleetDispatchYieldDiagnosticVerdict, number> = {
    actionable: 0,
    'insufficient-sample': 1,
    healthy: 2,
    'policy-suppressed': 3,
  };
  return candidates
    .slice()
    .sort((a, b) =>
      verdictRank[a.verdict] - verdictRank[b.verdict] ||
      b.noProposal - a.noProposal ||
      a.proposalRate - b.proposalRate ||
      b.diagnosticAttempts - a.diagnosticAttempts ||
      a.key.localeCompare(b.key),
    );
}

export function buildDispatchYieldDiagnostics(
  dispatchProduction: DispatchProductionYieldSummary,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): FleetDispatchYieldDiagnostics {
  const lowYieldRate = configuredLowDispatchYieldRate(cfg);
  const diagnosticAttempts = diagnosticAttemptsForDispatchSummary(dispatchProduction);
  const proposalsCreated = dispatchProduction.proposalsCreated;
  const proposalRate = diagnosticAttempts > 0 ? proposalsCreated / diagnosticAttempts : 0;
  const policyDisabled = diagnosticPolicyDisabled(dispatchProduction);
  const overallVerdict = dispatchYieldVerdict(diagnosticAttempts, proposalRate, policyDisabled, lowYieldRate);
  const byBackendSource = dispatchProduction.byBackendSource ?? [];
  const bucketSource = byBackendSource.length > 0
    ? byBackendSource.map((bucket) => dispatchYieldCandidate(bucket, 'backend-source', lowYieldRate))
    : dispatchProduction.byBackendModel.length > 0
      ? dispatchProduction.byBackendModel.map((bucket) => dispatchYieldCandidate(bucket, 'backend-model', lowYieldRate))
      : dispatchProduction.byBackend.map((bucket) => dispatchYieldCandidate(bucket, 'backend', lowYieldRate));
  const candidates = sortDispatchYieldCandidates(
    bucketSource.map((candidate) => effectiveDispatchYieldCandidate(candidate, cfg, backends)),
  ).slice(0, 5);
  const fleetTopReason = diagnosticTopReasonForDispatchSummary(dispatchProduction);
  const fleetCandidate = effectiveDispatchYieldCandidate({
    scope: 'fleet',
    key: 'fleet',
    diagnosticAttempts,
    proposalsCreated,
    noProposal: diagnosticNoProposalForDispatchSummary(dispatchProduction, diagnosticAttempts),
    proposalRate,
    policyDisabled,
    verdict: overallVerdict,
    action: dispatchYieldActionFor(overallVerdict, dispatchProduction.attemptShape),
    sameTierOnly: true,
    ...(fleetTopReason ? { topReason: fleetTopReason } : {}),
    ...(dispatchProduction.attemptShape ? { attemptShape: dispatchProduction.attemptShape } : {}),
    ...(dispatchProduction.generatedRepairAttempts
      ? { generatedRepairAttempts: dispatchProduction.generatedRepairAttempts }
      : {}),
  }, cfg, backends);
  const actionableCandidate = candidates.find((candidate) => candidate.verdict === 'actionable');
  const primaryCandidate = actionableCandidate ??
    (overallVerdict === 'healthy' || overallVerdict === 'policy-suppressed'
      ? fleetCandidate
      : candidates.find((candidate) => candidate.verdict === overallVerdict) ?? fleetCandidate);
  const verdict = primaryCandidate?.verdict === 'actionable' ? 'actionable' : overallVerdict;
  const action = primaryCandidate?.verdict === 'actionable'
    ? primaryCandidate.action
    : dispatchYieldActionFor(verdict, dispatchProduction.attemptShape);
  const topReason = primaryCandidate?.topReason ?? diagnosticTopReasonForDispatchSummary(dispatchProduction);
  const actionReason = primaryCandidate?.actionReason;
  return {
    windowHours: dispatchProduction.windowHours,
    minAttempts: MIN_DISPATCH_YIELD_ACTION_ATTEMPTS,
    lowYieldRate,
    diagnosticAttempts,
    proposalsCreated,
    proposalRate,
    policyDisabled,
    verdict,
    action,
    ...(actionReason ? { actionReason } : {}),
    sameTierOnly: true,
    recommendation: dispatchYieldRecommendation({
      verdict,
      action,
      actionReason,
      diagnosticAttempts,
      proposalRate,
      policyDisabled,
      primaryCandidate,
    }),
    ...(topReason ? { topReason } : {}),
    ...(dispatchProduction.attemptShape ? { attemptShape: dispatchProduction.attemptShape } : {}),
    ...(dispatchProduction.generatedRepairAttempts
      ? { generatedRepairAttempts: dispatchProduction.generatedRepairAttempts }
      : {}),
    ...(primaryCandidate ? { primaryCandidate } : {}),
    candidates,
  };
}

function dispatchYieldRecommendation(input: {
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  diagnosticAttempts: number;
  proposalRate: number;
  policyDisabled: number;
  primaryCandidate?: FleetDispatchYieldDiagnosticCandidate;
}): string {
  if (input.verdict === 'policy-suppressed') {
    return `${input.policyDisabled} attempt(s) were proposal-disabled by policy; do not treat them as backend weakness.`;
  }
  if (input.verdict === 'insufficient-sample') {
    const needed = Math.max(0, MIN_DISPATCH_YIELD_ACTION_ATTEMPTS - input.diagnosticAttempts);
    return `Collect ${needed} more diagnostic attempt(s) before changing routing.`;
  }
  if (input.verdict === 'healthy') {
    return `Keep current routing; diagnostic proposal yield is ${formatActionPercent(input.proposalRate)}.`;
  }
  const subject = input.primaryCandidate ? dispatchYieldSubject(input.primaryCandidate) : 'dispatches';
  if (input.action === 'route-same-tier-alternative') {
    return `Inspect ${subject} with same-tier alternatives only; avoid tier escalation until deterministic evidence supports it.`;
  }
  if (input.actionReason) {
    return `Tighten context or reslice ${subject}; ${input.actionReason}.`;
  }
  return `Tighten context or reslice ${subject}; capture/gate blocking dominates the low-yield sample.`;
}
