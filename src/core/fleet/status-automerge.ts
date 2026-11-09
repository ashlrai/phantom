/** Fleet status: automerge. Internal to status.ts. */

import type {
  FleetProposalSourceQuality,
  FleetProposalAuthoritySource,
  FleetAutoMergeReadinessStatus,
  FleetAutoMergeCanaryTelemetry,
  FleetAutoMergeCanaryStatus,
  FleetStatus,
  FleetAutoMergeBlockerSummary,
  FleetAutoMergeVerifierContractStatus,
} from './status-types.js';
import {
  AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
  type AutoMergeCanaryReadResult,
} from './automerge-canary-store.js';
import type {
  AshlrConfig,
  Proposal,
  AutoMergeTrustBasis,
} from '../types.js';
import {
  type AutoMergeCanaryPromotionReadiness,
  type AutoMergeCanaryPromotionReadinessInput,
  evaluateAutoMergeCanaryPromotionReadiness,
} from './automerge-canary-promotion-readiness.js';
import {
  resolveAutoMergeScopePolicy,
} from '../foundry/automerge-scope-policy.js';
import {
  autoMergeCanaryPolicyDigest,
  autoMergeCanaryConfigDigest,
} from './automerge-canary-observer.js';
import {
  detectRepoExecutionProfile,
} from '../run/repo-profile.js';
import {
  resolve,
  basename,
} from 'node:path';
import {
  defaultBranch,
} from '../git.js';
import {
  readDecisionsDetailed,
} from './decisions-ledger.js';

export function proposalAuthoritySource(
  quality: FleetProposalSourceQuality,
): FleetProposalAuthoritySource {
  if (quality.sourceState === 'healthy' && quality.sourcePresent && quality.complete) {
    return {
      gate: 'ready',
      detail: `complete proposal source (${quality.filesRead}/${quality.filesDiscovered} files read)`,
    };
  }
  const reasons = quality.stopReasons.length > 0
    ? `: ${quality.stopReasons.join(', ')}`
    : '';
  return {
    gate: 'unavailable',
    detail: `auto-merge authority requires a complete healthy proposal source; ` +
      `${quality.sourceState} source is ${quality.sourcePresent ? 'present' : 'absent'} and ` +
      `${quality.complete ? 'complete' : 'incomplete'}${reasons}`,
  };
}

export function remoteProtectionAuthorityReady(readiness: FleetAutoMergeReadinessStatus): boolean {
  const protection = readiness.remoteProtection;
  return !protection || !protection.required || (
    protection.configured === 'exact' &&
    protection.live === 'protected' &&
    protection.coverage === 'complete' &&
    protection.observedAt !== null &&
    Number.isFinite(Date.parse(protection.observedAt)) &&
    Date.now() - Date.parse(protection.observedAt) <= READINESS_REMOTE_PROTECTION_STALE_MS
  );
}

function unknownAutoMergeCanaryTelemetry(): FleetAutoMergeCanaryTelemetry {
  return {
    shadowCounters: null,
    outcomeRates: {
      eligible: null,
      rejected: null,
      bindingMismatch: null,
      inspectionError: null,
    },
    casRetries: null,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: null,
      remaining: null,
      reservedForTerminal: 1,
      observationWritesRemaining: null,
    },
    epochAgeMs: null,
    observationDeadlineRemainingMs: null,
    lastShadowEvidence: null,
  };
}

function fleetAutoMergeCanaryTelemetry(
  read: AutoMergeCanaryReadResult,
  now: Date,
): FleetAutoMergeCanaryTelemetry {
  if (read.sourceState !== 'healthy' || !read.state) return unknownAutoMergeCanaryTelemetry();
  const state = read.state;
  const attempts = state.shadowCounters.attempts;
  const nowMs = now.getTime();
  const activatedMs = Date.parse(state.activatedAt);
  const deadlineMs = state.observation.deadlineAt === null
    ? null
    : Date.parse(state.observation.deadlineAt);
  const rate = (count: number): number | null => attempts === 0
    ? null
    : Math.min(1, Math.max(0, count / attempts));
  const last = state.lastShadowEvidence;
  return {
    shadowCounters: { ...state.shadowCounters },
    outcomeRates: {
      eligible: rate(state.shadowCounters.eligible),
      rejected: rate(state.shadowCounters.rejected),
      bindingMismatch: rate(state.shadowCounters.bindingMismatches),
      inspectionError: rate(state.shadowCounters.inspectionErrors),
    },
    casRetries: state.shadowCounters.casRetries,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: state.revision,
      remaining: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision,
      reservedForTerminal: 1,
      observationWritesRemaining: Math.max(
        0,
        AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision - 1,
      ),
    },
    epochAgeMs: Number.isFinite(nowMs) && activatedMs <= nowMs ? nowMs - activatedMs : null,
    observationDeadlineRemainingMs: Number.isFinite(nowMs) && deadlineMs !== null &&
      state.observation.completedAt === null
      ? Math.max(0, deadlineMs - nowMs)
      : null,
    lastShadowEvidence: last === null ? null : {
      observedAt: last.observedAt,
      outcome: last.outcome,
      mismatchFields: [...last.mismatchFields],
      fileCount: last.fileCount,
      lineCount: last.lineCount,
    },
  };
}

function conciseAutoMergeCanaryState(
  state: AutoMergeCanaryReadResult['state'],
): FleetAutoMergeCanaryStatus['current'] {
  if (!state) return null;
  return {
    epochId: state.epochId,
    revision: state.revision,
    mode: state.mode,
    state: state.state,
    activatedAt: state.activatedAt,
    updatedAt: state.updatedAt,
    budgets: { ...state.budgets },
    counters: { ...state.counters },
    blocker: state.blocker === null ? null : { ...state.blocker },
  };
}

export function projectAutoMergeCanaryStatus(
  read: AutoMergeCanaryReadResult,
  now = new Date(),
): FleetAutoMergeCanaryStatus {
  return {
    authority: 'observation-only',
    policyEligible: false,
    enforceSupported: false,
    hostCancellationProven: false,
    sourceState: read.sourceState,
    severity: read.severity,
    status: read.status,
    active: read.active,
    current: read.sourceState === 'healthy' ? conciseAutoMergeCanaryState(read.state) : null,
    telemetry: fleetAutoMergeCanaryTelemetry(read, now),
    revisionCount: read.sourceState === 'healthy' ? read.revisions.length : null,
    terminalEpochCount: read.sourceState === 'healthy' ? read.terminalEpochs.length : null,
    diagnostics: [...read.diagnostics],
    limitExceeded: read.limitExceeded,
  };
}

export function degradedAutoMergeCanaryStatus(): FleetAutoMergeCanaryStatus {
  return {
    authority: 'observation-only',
    policyEligible: false,
    enforceSupported: false,
    hostCancellationProven: false,
    sourceState: 'degraded',
    severity: 'critical',
    status: 'critical',
    active: false,
    current: null,
    telemetry: unknownAutoMergeCanaryTelemetry(),
    revisionCount: null,
    terminalEpochCount: null,
    diagnostics: ['storage-unsafe'],
    limitExceeded: false,
  };
}

export function buildAutoMergeCanaryPromotionReadiness(
  status: FleetStatus,
  cfg: AshlrConfig,
  read: AutoMergeCanaryReadResult,
  observedAtMs: number,
): AutoMergeCanaryPromotionReadiness {
  const state = read.sourceState === 'healthy' ? read.state : null;
  const counters = state?.shadowCounters;
  const remote = status.autoMergeReadiness?.remoteProtection;
  const coverage = status.queue.repos?.executionProfiles;
  const registryDegraded = status.queue.repos?.registry?.state === 'degraded';
  const detached = status.detachedPostMergeVerificationReadiness;
  const detachedSource = status.detachedPostMergeVerificationSource;
  const detachedDenominatorSource = status.detachedPostMergeDenominatorSource;
  const detachedComplete = detachedSource?.sourceState === 'healthy' &&
    detachedSource.complete === true &&
    detachedDenominatorSource?.sourceState === 'healthy' &&
    detachedDenominatorSource.complete === true &&
    detached !== undefined &&
    detached.state === 'conclusive' &&
    detached.denominator.eligibleCandidates > 0 &&
    detached.denominator.observedCandidates === detached.denominator.eligibleCandidates &&
    detached.denominator.conclusiveCandidates === detached.denominator.eligibleCandidates;
  const autoMerge = cfg.foundry?.autoMerge;
  const autoMergeRecord = autoMerge as Record<string, unknown> | undefined;
  const configuredScopeCap = (key: 'maxAutomergeFiles' | 'maxAutomergeLines'): number | null | undefined => {
    if (!autoMergeRecord || !Object.prototype.hasOwnProperty.call(autoMergeRecord, key)) return undefined;
    const value = autoMergeRecord[key];
    return typeof value === 'number' ? value : null;
  };
  const maxAutomergeFiles = configuredScopeCap('maxAutomergeFiles');
  const maxAutomergeLines = configuredScopeCap('maxAutomergeLines');
  const currentScopePolicy = resolveAutoMergeScopePolicy(autoMerge);
  const lastShadowEvidence = state?.lastShadowEvidence ?? null;
  const input: AutoMergeCanaryPromotionReadinessInput = {
    observedAtMs,
    canary: {
      sourceState: read.sourceState,
      active: read.active === true && state?.mode === 'shadow',
      state: state?.state ?? (read.status === 'critical' ? 'critical' : 'inactive'),
      observationCompletedAt: state?.observation.completedAt ?? null,
      attempts: counters?.attempts ?? 0,
      eligible: counters?.eligible ?? 0,
      rejected: counters?.rejected ?? 0,
      requiredAttempts: 1,
      requiredEligible: 1,
      // No current configuration field binds a minimum promotion sample.
      requirementsBound: false,
      bindingMismatches: counters?.bindingMismatches ?? 0,
      inspectionErrors: counters?.inspectionErrors ?? 0,
    },
    remoteProtection: {
      configured: remote?.configured === 'exact'
        ? 'exact'
        : remote?.configured === 'missing' || remote === undefined ? 'missing' : 'partial',
      live: remote?.live === 'protected' || remote?.live === 'unprotected'
        ? remote.live
        : 'unavailable',
      coverage: remote?.coverage === 'complete'
        ? 'complete'
        : remote?.coverage === 'partial' ? 'partial' : 'none',
      observedAt: remote?.observedAt ?? null,
    },
    verification: {
      sourceState: registryDegraded ? 'degraded' : coverage ? 'healthy' : 'missing',
      enrolledRepos: status.queue.repos?.enrolled ?? 0,
      mergeGradeRepos: coverage?.reposWithExplicitMergeContracts ?? 0,
      noCommandRepos: coverage?.reposMissingVerifyCommands ?? 0,
    },
    // Current Fleet Status has no release-scoped signing or rollback authority
    // source. Missing evidence must remain explicit rather than inferred.
    evidenceSigning: {
      sourceState: 'missing',
      signed: false,
      writable: false,
      expiresAt: null,
    },
    release: {
      sourceState: 'missing',
      signatureVerified: false,
      manifestComplete: false,
      artifactBound: false,
      serviceInvocationBound: false,
      configurationBound: false,
      expiresAt: null,
      rollbackBound: false,
    },
    postMerge: {
      sourceState: detachedSource?.sourceState ?? 'missing',
      complete: detachedComplete,
      denominatorComplete: detachedComplete,
      releasedCohorts: detached?.denominator.conclusiveCandidates ?? 0,
      adverseObservations: (detached?.denominator.fail ?? 0) +
        (detached?.denominator.unknown ?? 0),
      latestCompletedAt: detached?.latestObservedAt ?? null,
    },
    policy: {
      allowSelfMerge: autoMerge?.allowSelfMerge === true,
      allowWithoutVerification: autoMerge?.allowWithoutVerification === true,
      localMergeFallback: autoMerge?.enabled === true && autoMerge.pushToRemote !== true,
      ...(maxAutomergeFiles !== undefined ? { maxAutomergeFiles } : {}),
      ...(maxAutomergeLines !== undefined ? { maxAutomergeLines } : {}),
    },
    scopeIdentity: {
      sourceState: read.sourceState,
      expectedPolicyDigest: state?.policyDigest ?? null,
      expectedConfigDigest: state?.configDigest ?? null,
      evidencePolicyDigest: lastShadowEvidence?.policyDigest ?? null,
      evidenceConfigDigest: lastShadowEvidence?.configDigest ?? null,
      currentPolicyDigest: autoMergeCanaryPolicyDigest(),
      currentConfigDigest: autoMergeCanaryConfigDigest(cfg),
      currentScopePolicyDigest: currentScopePolicy.ok ? currentScopePolicy.policy.digest : null,
      observedAt: lastShadowEvidence?.observedAt ?? null,
    },
  };
  return evaluateAutoMergeCanaryPromotionReadiness(input);
}

export const READINESS_REMOTE_PROTECTION_STALE_MS = 5 * 60 * 1000;

const MAX_REMOTE_PROTECTION_STATUS_REPOS = 32;

export async function buildAutoMergeReadinessStatus(
  cfg: AshlrConfig,
  pendingProposals: Proposal[],
  enrolledRepos: string[],
  enrollmentRegistry: { state: 'ready' } | { state: 'degraded'; reason: string },
): Promise<FleetAutoMergeReadinessStatus> {
  const autoMerge = cfg.foundry?.autoMerge;
  const enabled = autoMerge?.enabled === true;
  const trustBasis: AutoMergeTrustBasis =
    autoMerge?.trustBasis === 'verification' || autoMerge?.trustBasis === 'evidence'
      ? autoMerge.trustBasis
      : 'tier';
  const rawTrustBasis = autoMerge?.trustBasis;
  const rawMaxRisk = (autoMerge as Record<string, unknown> | undefined)?.['maxRisk'];
  const trustBasisBlocker =
    rawTrustBasis !== undefined &&
    rawTrustBasis !== 'tier' &&
    rawTrustBasis !== 'verification' &&
    rawTrustBasis !== 'evidence'
      ? `invalid auto-merge trustBasis '${String(rawTrustBasis)}'`
      : undefined;
  const maxRiskBlocker = rawMaxRisk !== undefined &&
    rawMaxRisk !== 'low' && rawMaxRisk !== 'medium' && rawMaxRisk !== 'high'
    ? `invalid auto-merge maxRisk '${String(rawMaxRisk)}'`
    : undefined;
  const configurationBlocker = trustBasisBlocker ?? maxRiskBlocker;
  const maxRisk = rawMaxRisk === 'medium' || rawMaxRisk === 'high' ? rawMaxRisk : 'low';

  const byReason: Record<string, number> = {};
  const recentBlockers: FleetAutoMergeBlockerSummary[] = [];
  let preflightReady = 0;
  let branchAuthorityReady = 0;
  let remoteMainAuthorityReady = 0;
  let authorityBlocked = 0;
  const authorityByReason: Record<string, number> = {};
  let needsVerification = 0;
  let knownVerificationFailed = 0;
  let blocked = 0;
  const verifierContracts: FleetAutoMergeVerifierContractStatus = {
    pendingNeedingVerification: 0,
    withoutVerifyCommands: 0,
    withoutExplicitMergeContract: 0,
    recentGaps: [],
  };
  const profileCache = new Map<string, ReturnType<typeof detectRepoExecutionProfile> | null>();

  const {
    classifyRisk,
    evaluateBranchAuthority,
    evaluateAutoMergeReadinessPreflight,
    evaluateEvidenceRemoteProtectionSignal,
    evaluateLiveProtectedRemoteAuthority,
    evaluateMergeAuthority,
    explainAutoMergeGate,
    mergeTargetForTier,
    resolveRemoteBranchHead,
  } = await import('../inbox/merge.js');
  const { hashDiff } = await import('../foundry/provenance.js');
  const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const legacyRemoteProtectionSignal = evaluateEvidenceRemoteProtectionSignal(cfg);
  const remoteMainProposals = pendingProposals.filter((proposal) =>
    trustBasis !== 'tier' || mergeTargetForTier(proposal.engineTier) === 'main');
  const remoteMainRepos = new Set(
    (pendingProposals.length === 0 ? enrolledRepos : remoteMainProposals.map((proposal) => proposal.repo))
      .filter((repo): repo is string => typeof repo === 'string' && repo.length > 0)
      .map((repo) => resolve(repo)),
  );
  const perRepository = Boolean(autoMerge && Object.hasOwn(autoMerge, 'protectedRemotes'));
  const selectedSignals = perRepository ? [...remoteMainRepos].map((repo) => evaluateEvidenceRemoteProtectionSignal(cfg, repo)) : [];
  const remoteProtectionSignal = perRepository ? {
    ok: selectedSignals.length > 0 && selectedSignals.every((signal) => signal.ok),
    expectationMode: selectedSignals.length > 0 && selectedSignals.every((signal) => signal.expectationMode === 'exact')
      ? 'exact' as const : selectedSignals.some((signal) => signal.expectationMode === 'invalid') ? 'invalid' as const : 'missing' as const,
    detail: selectedSignals.find((signal) => !signal.ok)?.detail ?? 'repository-bound protected PR expectations selected',
  } : legacyRemoteProtectionSignal;
  const remoteDeliveryEnabled = enabled && autoMerge?.pushToRemote === true;
  const remoteProtectionRequired = remoteDeliveryEnabled && (
    pendingProposals.length === 0 || remoteMainProposals.length > 0
  );
  const remoteProtection: FleetAutoMergeReadinessStatus['remoteProtection'] = {
    required: remoteProtectionRequired,
    configured: remoteProtectionSignal.expectationMode,
    live: 'unobserved',
    coverage: 'unscoped',
    observedAt: null,
    reposObserved: 0,
    reposRequired: remoteMainRepos.size,
    detail: remoteProtectionRequired
      ? remoteProtectionSignal.ok
        ? 'protected remote configuration is exact, but fleetwide live protection has not been observed'
        : `protected remote configuration is not authoritative: ${remoteProtectionSignal.detail}`
      : 'protected remote authority is not required because remote main delivery is disabled',
  };
  if (enrollmentRegistry.state === 'degraded') {
    const reason = `enrollment authority degraded: ${enrollmentRegistry.reason}`;
    const withheld = pendingProposals.length;
    remoteProtection.detail = `${reason}; protected remote authority is withheld`;
    return {
      enabled,
      trustBasis,
      pending: withheld,
      preflightReady: 0,
      authorityReady: 0,
      branchAuthorityReady: 0,
      remoteMainAuthorityReady: 0,
      authorityBlocked: withheld,
      authorityByReason: withheld > 0 ? { [reason]: withheld } : {},
      needsVerification: 0,
      knownVerificationFailed: 0,
      blocked: withheld,
      byReason: withheld > 0 ? { [reason]: withheld } : {},
      recentBlockers: pendingProposals.slice(0, 8).map((proposal) => ({
        proposalId: proposal.id,
        title: proposal.title,
        tier: proposal.engineTier ?? null,
        reason,
        riskClass: null,
      })),
      verifierContracts,
      ...(configurationBlocker ? { configurationBlocker } : {}),
      remoteProtection,
    };
  }
  if (remoteProtectionRequired && (remoteProtectionSignal.ok || perRepository) && remoteMainRepos.size > 0) {
    const targets = new Map<string, {
      repo: string;
      bindings: Map<string, { branch: string; baseHead: string | null }>;
    }>();
    for (const repo of remoteMainRepos) {
      targets.set(repo, { repo, bindings: new Map() });
    }
    for (const proposal of remoteMainProposals) {
      const repo = proposal.repo;
      const branch = proposal.verifyResult?.baseBranch;
      const baseHead = proposal.verifyResult?.baseHead;
      if (!repo || !branch || !baseHead) continue;
      const target = targets.get(resolve(repo));
      target?.bindings.set(`${branch}\0${baseHead}`, { branch, baseHead });
    }
    if (pendingProposals.length === 0) {
      for (const repo of enrolledRepos) {
        const branch = defaultBranch(repo);
        targets.get(resolve(repo))?.bindings.set(branch, {
          branch,
          baseHead: resolveRemoteBranchHead(repo, branch),
        });
      }
    }
    const boundedTargets = [...targets.values()].slice(0, MAX_REMOTE_PROTECTION_STATUS_REPOS);
    const observations: Array<Awaited<ReturnType<typeof evaluateLiveProtectedRemoteAuthority>>> = [];
    for (let offset = 0; offset < boundedTargets.length; offset += 4) {
      const batch = boundedTargets.slice(offset, offset + 4);
      observations.push(...await Promise.all(batch.map((target) => {
        const bindings = [...target.bindings.values()];
        if (bindings.length !== 1) {
          return Promise.resolve({
            authorized: false as const,
            reason: bindings.length === 0
              ? `protected remote base binding unavailable for ${basename(target.repo)}`
              : `conflicting protected remote base bindings for ${basename(target.repo)}`,
          });
        }
        const binding = bindings[0]!;
        return binding.baseHead
          ? evaluateLiveProtectedRemoteAuthority(target.repo, binding.branch, binding.baseHead, cfg)
          : Promise.resolve({
              authorized: false as const,
              reason: `protected remote base head unavailable for ${basename(target.repo)}:${binding.branch}`,
            });
      })));
    }
    remoteProtection.reposObserved = observations.length;
    remoteProtection.coverage =
      targets.size === remoteMainRepos.size && observations.length === remoteMainRepos.size
        ? 'complete'
        : observations.length > 0
          ? 'partial'
          : 'unscoped';
    const failures = observations.filter((observation) => !observation.authorized);
    if (failures.length > 0) {
      remoteProtection.live = failures.some((failure) => failure.reason.includes('unavailable'))
        ? 'unavailable'
        : 'unprotected';
      remoteProtection.detail = failures[0]!.reason;
    } else if (observations.length > 0) {
      remoteProtection.live = 'protected';
      remoteProtection.observedAt = observations
        .map((observation) => observation.authorized ? observation.evidence.observedAt : '')
        .filter(Boolean)
        .sort()
        .at(0) ?? null;
      const observedMs = remoteProtection.observedAt ? Date.parse(remoteProtection.observedAt) : NaN;
      if (!Number.isFinite(observedMs) || Date.now() - observedMs > READINESS_REMOTE_PROTECTION_STALE_MS) {
        remoteProtection.live = 'unavailable';
        remoteProtection.detail = 'live protected-remote observation is missing or stale';
      } else {
        remoteProtection.detail = remoteProtection.coverage === 'complete'
          ? `live protected-remote authority confirmed for ${observations.length} remote main target(s)`
          : `live protection confirmed for ${observations.length}/${remoteMainRepos.size} remote main target(s)`;
      }
    }
  }

  const noteBlocker = (proposal: Proposal, reason: string, riskClass: string | null): void => {
    blocked++;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (recentBlockers.length < 8) {
      recentBlockers.push({
        proposalId: proposal.id,
        title: proposal.title,
        tier: proposal.engineTier ?? null,
        reason,
        riskClass,
      });
    }
  };
  const noteAuthorityBlocker = (reason: string): void => {
    authorityBlocked++;
    authorityByReason[reason] = (authorityByReason[reason] ?? 0) + 1;
  };
  const profileForRepo = (repo: string): ReturnType<typeof detectRepoExecutionProfile> | null => {
    const key = resolve(repo);
    if (profileCache.has(key)) return profileCache.get(key) ?? null;
    try {
      const profile = detectRepoExecutionProfile(repo);
      profileCache.set(key, profile);
      return profile;
    } catch {
      profileCache.set(key, null);
      return null;
    }
  };
  const noteVerifierContractGap = (proposal: Proposal): void => {
    if (trustBasis !== 'verification' && trustBasis !== 'evidence') return;
    if (!proposal.repo) return;
    verifierContracts.pendingNeedingVerification++;
    const profile = profileForRepo(proposal.repo);
    const withoutVerifyCommands = !profile || profile.verifyCommands.length === 0;
    const withoutExplicitMergeContract = profile?.verifyContract?.mergeGradeExplicit !== true ||
      profile.verifyContractSource !== 'tracked-clean';
    if (!withoutVerifyCommands && !withoutExplicitMergeContract) return;
    if (withoutVerifyCommands) verifierContracts.withoutVerifyCommands++;
    if (withoutExplicitMergeContract) verifierContracts.withoutExplicitMergeContract++;
    if (verifierContracts.recentGaps.length < 8) {
      verifierContracts.recentGaps.push({
        proposalId: proposal.id,
        title: proposal.title,
        repo: proposal.repo,
        name: basename(proposal.repo),
        withoutVerifyCommands,
        withoutExplicitMergeContract,
        reason:
          profile?.noVerifyReason ??
          (profile?.verifyContract?.mergeGradeExplicit && profile.verifyContractSource !== 'tracked-clean'
            ? `ashlr.verify.json is ${profile.verifyContractSource}; merge contract must be tracked-clean`
            : profile?.verifyContract?.mergeGradeReason) ??
          'missing explicit merge-profile verification contract',
      });
    }
  };

  for (const proposal of pendingProposals) {
    let riskClass: string | null = null;

    if (!enabled) {
      noteBlocker(proposal, 'auto-merge disabled', riskClass);
      continue;
    }
    if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
      noteBlocker(proposal, `proposal kind '${proposal.kind}' is not mergeable`, riskClass);
      continue;
    }
    if (!proposal.diff?.trim()) {
      noteBlocker(proposal, 'proposal has no diff', riskClass);
      continue;
    }
    if (!proposal.repo) {
      noteBlocker(proposal, 'proposal has no repo', riskClass);
      continue;
    }
    if (proposal.verifyResult?.passed === false) {
      knownVerificationFailed++;
      const failed = proposal.verifyResult.failed?.filter(Boolean).join('; ');
      noteBlocker(
        proposal,
        failed ? `known verification failure: ${failed}` : 'known verification failure',
        riskClass,
      );
      continue;
    }

    const readiness = evaluateAutoMergeReadinessPreflight(proposal, cfg);
    if (!readiness.ready) {
      noteBlocker(proposal, readiness.reason ?? 'not ready for auto-merge', riskClass);
      continue;
    }

    if (trustBasis === 'tier') {
      const target = mergeTargetForTier(proposal.engineTier);
      const authority =
        target === 'main'
          ? evaluateMergeAuthority(proposal, cfg)
          : target === 'branch'
            ? evaluateBranchAuthority(proposal, cfg)
            : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only` };
      if (!authority.authorized) {
        noteBlocker(proposal, `merge authority denied: ${authority.reason}`, riskClass);
        continue;
      }
    }

    if (!proposal.engineModel) {
      noteBlocker(proposal, 'provenance check failed: missing engineModel', riskClass);
      continue;
    }
    if (!proposal.engineTier) {
      noteBlocker(proposal, 'provenance check failed: missing engineTier', riskClass);
      continue;
    }
    if (!proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: missing diffHash', riskClass);
      continue;
    }
    if (!proposal.provenanceSig) {
      noteBlocker(proposal, 'provenance check failed: missing provenanceSig', riskClass);
      continue;
    }
    if (hashDiff(proposal.diff) !== proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: diff hash mismatch', riskClass);
      continue;
    }

    riskClass = classifyRisk(proposal);
    if ((riskOrder[riskClass] ?? Number.POSITIVE_INFINITY) > (riskOrder[maxRisk] ?? 0)) {
      noteBlocker(proposal, `risk class '${riskClass}' exceeds maxRisk '${maxRisk}'`, riskClass);
      continue;
    }

    if (trustBasis === 'verification' && proposal.verifyResult?.passed !== true) {
      noteVerifierContractGap(proposal);
      needsVerification++;
      continue;
    }

    if (trustBasis === 'evidence') {
      const verify = proposal.verifyResult;
      const hasBaseBinding =
        verify?.passed === true &&
        typeof verify.baseBranch === 'string' &&
        verify.baseBranch.length > 0 &&
        typeof verify.baseHead === 'string' &&
        verify.baseHead.length > 0;
      const hasCurrentDiffBinding =
        hasBaseBinding &&
        typeof verify.diffHash === 'string' &&
        verify.diffHash === hashDiff(proposal.diff);
      if (!hasCurrentDiffBinding) {
        noteVerifierContractGap(proposal);
        needsVerification++;
        continue;
      }
    }

    preflightReady++;

    if (trustBasis === 'tier') {
      if (mergeTargetForTier(proposal.engineTier) === 'branch') branchAuthorityReady++;
      else remoteMainAuthorityReady++;
      continue;
    }

    if (trustBasis === 'evidence') {
      noteAuthorityBlocker('fresh isolated verification is required by the mutating evidence-mode gate');
      continue;
    }

    const proposalCreatedMs = Date.parse(proposal.createdAt);
    const decisionsRead = readDecisionsDetailed({
      proposalId: proposal.id,
      ...(Number.isFinite(proposalCreatedMs) ? { sinceMs: proposalCreatedMs - 60_000 } : {}),
    });
    if (decisionsRead.sourceState === 'degraded' || !decisionsRead.complete) {
      noteAuthorityBlocker('decisions ledger source is degraded or incomplete');
      continue;
    }
    const authority = explainAutoMergeGate(proposal, cfg, {
      decisionsForProposal: decisionsRead.decisions,
    });
    if (!authority.mergeable) {
      noteAuthorityBlocker(authority.reason);
      continue;
    }
    remoteMainAuthorityReady++;
  }

  const remoteMainReady = remoteProtectionAuthorityReady({
    enabled,
    trustBasis,
    pending: pendingProposals.length,
    preflightReady,
    needsVerification,
    knownVerificationFailed,
    blocked,
    byReason,
    recentBlockers,
    remoteProtection,
  });
  if (!remoteMainReady && remoteMainAuthorityReady > 0) {
    const reason = remoteProtection?.detail ?? 'protected remote authority is unavailable';
    authorityBlocked += remoteMainAuthorityReady;
    authorityByReason[reason] = (authorityByReason[reason] ?? 0) + remoteMainAuthorityReady;
  }
  const authorityReady = branchAuthorityReady + (remoteMainReady ? remoteMainAuthorityReady : 0);

  return {
    enabled,
    trustBasis,
    pending: pendingProposals.length,
    preflightReady,
    authorityReady,
    branchAuthorityReady,
    remoteMainAuthorityReady,
    authorityBlocked,
    authorityByReason,
    needsVerification,
    knownVerificationFailed,
    blocked,
    byReason,
    recentBlockers,
    verifierContracts,
    ...(configurationBlocker ? { configurationBlocker } : {}),
    remoteProtection,
  };
}
