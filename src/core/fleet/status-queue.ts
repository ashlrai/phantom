/** Fleet status: queue. Internal to status.ts. */

import {
  createHash,
} from 'node:crypto';
import {
  type RepairHandoffSchemaSummary,
  readRepairHandoffs,
} from './repair-handoff-journal.js';
import type {
  RepairHandoffWriterRuntime,
  FleetRepairHandoffRolloutStatus,
  FleetQueueInventorySourceStatus,
  FleetQueueGeneratedWorkStatus,
  FleetDiagnosticResliceDrainStatus,
  FleetQueueEligibility,
  FleetGeneratedRepairRouteStatus,
  FleetStatus,
  FleetReadinessSourceStatus,
  FleetQueueRepoCoverage,
} from './status-types.js';
import type {
  DaemonTick,
  WorkItem,
  Proposal,
  AshlrConfig,
} from '../types.js';
import {
  READINESS_QUEUE_STALE_MS,
} from './status-readiness-signals.js';
import {
  resolve,
  basename,
} from 'node:path';
import {
  RECENT_WINDOW_MS,
  configCooldownMs,
} from './status-sources.js';
import {
  DEFAULT_COOLDOWN_MS,
  latestWorkedEventForKeys,
  isSuppressibleWorkedOutcome,
  type WorkedEvent,
  GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS,
} from './worked-ledger.js';
import {
  selectWorkQueueCoordinator,
} from '../seams/work-queue-coordinator.js';
import {
  readGeneratedRepairQueueSnapshot,
  type GeneratedRepairDispatchState,
} from './generated-repair-lifecycle.js';
import {
  blockingPendingProposalsForBacklog,
  pendingProposalItemKeysForBacklog,
  workItemCoverageKey,
} from './proposal-matching.js';
import {
  type GeneratedRepairRouteReason,
  type GeneratedRepairRouteFeasibility,
  inspectGeneratedRepairRouteFeasibility,
} from './router.js';
import {
  isTrustedGeneratedRepairItem,
} from './self-heal-trust.js';
import type {
  ListGoalsDetailedResult,
} from '../goals/store.js';
import type {
  FleetLaneLockSourceQualityPart,
  FleetLaneLockSourceReason,
} from './lane-lock.js';
import {
  type RepoPackageManager,
  detectRepoExecutionProfile,
} from '../run/repo-profile.js';

const MAX_GENERATED_REPAIR_ROUTE_BLOCKED_ITEMS = 50;

const MAX_GENERATED_REPAIR_ROUTE_ITEM_ID = 160;

function boundedRepairRouteItemId(itemId: string): string {
  if (itemId.length <= MAX_GENERATED_REPAIR_ROUTE_ITEM_ID) return itemId;
  const digest = createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-route-item:v1', itemId]))
    .digest('hex');
  return `sha256:${digest}`;
}

export function buildRepairHandoffRolloutStatus(
  summary: RepairHandoffSchemaSummary,
  writerEnabled: boolean,
  eligibleOrdinaryItems: number | null,
  projectionTickAt: string | null = null,
  runtime: RepairHandoffWriterRuntime = {},
): FleetRepairHandoffRolloutStatus {
  const writerEffective = runtime.effective ?? writerEnabled;
  const activationV2Authorities = runtime.activationAware
    ? summary.currentActivationV2Authorities
    : summary.v2Authorities;
  const phase: FleetRepairHandoffRolloutStatus['phase'] = summary.sourceState === 'degraded' || summary.limitExceeded
    ? 'degraded'
    : !writerEnabled
      ? 'reader-only'
      : !writerEffective
        ? 'blocked'
      : activationV2Authorities === 0
        ? 'awaiting-evidence'
        : summary.v1Authorities > 0 ? 'mixed-healthy' : 'v2-healthy';
  const action: FleetRepairHandoffRolloutStatus['action'] = phase === 'degraded'
    ? writerEnabled ? 'rollback-writer' : 'inspect-source'
    : phase === 'blocked'
      ? 'repair-writer-config'
    : phase === 'reader-only'
      ? eligibleOrdinaryItems === null
        ? 'inspect-source'
        : eligibleOrdinaryItems > 0
          ? 'enable-canary'
          : 'wait-ordinary-parent'
      : phase === 'mixed-healthy' || phase === 'v2-healthy'
        ? projectionTickAt ? 'retain-writer' : 'observe-projection'
        : eligibleOrdinaryItems === null
          ? 'inspect-source'
        : eligibleOrdinaryItems > 0
          ? 'observe-writer'
          : 'wait-ordinary-parent';
  return {
    summaryAvailable: true,
    writerConfigured: writerEnabled,
    writerEnabled,
    writerEffective,
    writerBlockedReason: runtime.blockedReason ?? null,
    activationId: runtime.activation?.id ?? null,
    activatedAt: runtime.activation?.activatedAt ?? null,
    phase,
    sourceState: summary.sourceState,
    v1Authorities: summary.v1Authorities,
    v2Authorities: summary.v2Authorities,
    v1PhysicalRows: summary.v1PhysicalRows,
    v2PhysicalRows: summary.v2PhysicalRows,
    aliasFamilies: summary.aliasFamilies,
    latestV2At: summary.latestV2At,
    currentActivationV2Authorities: summary.currentActivationV2Authorities,
    unboundV2Authorities: summary.unboundV2Authorities,
    latestCurrentActivationV2At: summary.latestCurrentActivationV2At,
    authorityDigest: summary.authorityDigest,
    projectionObserved: projectionTickAt !== null,
    projectionTickAt,
    invalidRows: summary.invalidRows,
    conflictingIds: summary.conflictingIds,
    limitExceeded: summary.limitExceeded,
    eligibleOrdinaryItems,
    action,
  };
}

export function repairHandoffProjectionTick(
  recentTicks: readonly DaemonTick[],
  authorityDigest: string,
  notBefore: string | null = null,
  activationProof?: {
    id: string;
    activatedAt: string;
    authorities: number;
    authorityDigest: string;
  },
): string | null {
  const notBeforeMs = notBefore === null ? null : Date.parse(notBefore);
  for (let index = recentTicks.length - 1; index >= 0; index--) {
    const tick = recentTicks[index]!;
    if (notBeforeMs !== null && (!Number.isFinite(Date.parse(tick.ts)) || Date.parse(tick.ts) < notBeforeMs)) continue;
    const maintenance = tick.producerMaintenance;
    // Lifecycle-unavailable repairs are retained, dispatch-blocked inventory;
    // they do not weaken an exact healthy authority-journal projection.
    if (
      maintenance?.proposalRepair === true &&
      maintenance.repairHandoffSourceState === 'healthy' &&
      maintenance.repairHandoffAuthorityDigest === authorityDigest &&
      (maintenance.repairHandoffInvalidRows ?? 0) === 0 &&
      (maintenance.repairHandoffConflictingIds ?? 0) === 0 &&
      (maintenance.repairHandoffCompactionUnavailable ?? 0) === 0 &&
      maintenance.proposalRepairInboxAvailable === true
      && (!activationProof || (
        maintenance.repairHandoffActivationId === activationProof.id &&
        maintenance.repairHandoffActivatedAt === activationProof.activatedAt &&
        maintenance.repairHandoffActivationAuthorities === activationProof.authorities &&
        maintenance.repairHandoffActivationAuthorityDigest === activationProof.authorityDigest &&
        activationProof.authorities > 0
      ))
    ) return tick.ts;
  }
  return null;
}

const QUEUE_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function queueInventoryFreshness(
  observedAt: string | null,
  nowMs = Date.now(),
): FleetQueueInventorySourceStatus['freshness'] {
  if (!observedAt) return 'unknown';
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + QUEUE_SOURCE_FUTURE_SKEW_MS) return 'unknown';
  return nowMs - observedMs <= READINESS_QUEUE_STALE_MS ? 'fresh' : 'stale';
}

function isVisibleBacklogItem(item: WorkItem, enrolledRepos: Set<string>): boolean {
  if (enrolledRepos.size === 0) return false;
  return enrolledRepos.has(resolve(item.repo));
}

export function mergeVisibleQueueItems(items: WorkItem[], enrolledRepos: Set<string>): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
  for (const item of items) {
    if (!isVisibleBacklogItem(item, enrolledRepos)) continue;
    const key = `${resolve(item.repo)}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function buildQueueGeneratedWorkStatus(items: WorkItem[]): FleetQueueGeneratedWorkStatus | undefined {
  let selfHeal = 0;
  let proposalRepair = 0;
  let captureRepairs = 0;
  let diagnosticReslices = 0;
  let invent = 0;
  for (const item of items) {
    if (item.source === 'invent') invent++;
    if (item.tags.includes('self-heal')) selfHeal++;
    if (item.tags.includes('proposal-repair')) proposalRepair++;
    if (item.tags.includes('dispatch-capture-repair')) captureRepairs++;
    if (item.tags.includes('dispatch-no-diff-reslice')) diagnosticReslices++;
  }
  const total = items.filter((item) =>
    item.source === 'invent' ||
    item.tags.includes('self-heal') ||
    item.tags.includes('proposal-repair') ||
    item.tags.includes('dispatch-capture-repair') ||
    item.tags.includes('dispatch-no-diff-reslice')
  ).length;
  if (total === 0) return undefined;
  return { total, selfHeal, proposalRepair, captureRepairs, diagnosticReslices, invent };
}

function latestRecentDiagnosticResliceDrainTick(ticks: DaemonTick[], nowMs = Date.now()): DaemonTick | null {
  const cutoff = nowMs - RECENT_WINDOW_MS;
  let latestTargeted: DaemonTick | null = null;
  let latestTargetedMs = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    if (tick.drain?.mode !== 'diagnostic-reslices') continue;
    const ts = Date.parse(tick.ts);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const safeTs = Number.isFinite(ts) ? ts : nowMs;
    if (!latestTargeted || safeTs >= latestTargetedMs) {
      latestTargeted = tick;
      latestTargetedMs = safeTs;
    }
  }
  return latestTargeted;
}

export function buildDiagnosticResliceDrainStatus(
  ticks: DaemonTick[],
  nowMs = Date.now(),
): FleetDiagnosticResliceDrainStatus | undefined {
  const latest = latestRecentDiagnosticResliceDrainTick(ticks, nowMs);
  const drain = latest?.drain;
  if (!latest || drain?.mode !== 'diagnostic-reslices') return undefined;
  const production = latest.proposalProduction;
  const topReasons = production?.reasons
    ?.filter((reason) => reason.count > 0)
    .slice(0, 5)
    .map((reason) => ({ reason: reason.reason, count: reason.count }));
  return {
    mode: drain.mode,
    latestAt: latest.ts,
    available: drain.available,
    selected: drain.selected,
    ...(typeof drain.limit === 'number' ? { limit: drain.limit } : {}),
    ...(drain.capped ? { capped: true } : {}),
    ...(drain.automatic ? { automatic: true } : {}),
    ...(drain.selectedItemIds?.length ? { selectedItemIds: drain.selectedItemIds.slice(0, 12) } : {}),
    ...(drain.stalled || (drain.available > 0 && drain.selected === 0) ? { stalled: true } : {}),
    dispatched: production?.dispatched ?? 0,
    skipped: production?.skipped ?? 0,
    errors: production?.errors ?? 0,
    proposalsCreated: production?.proposalsCreated ?? latest.proposalsCreated ?? 0,
    noProposalDispatches: production?.noProposalDispatches ?? 0,
    ...(topReasons && topReasons.length > 0 ? { topReasons } : {}),
  };
}

function isoFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

export function buildQueueEligibility(
  items: WorkItem[],
  pendingProposals: Proposal[],
  cfg: AshlrConfig,
  repairControlAvailable: boolean = readRepairHandoffs().sourceState !== 'degraded',
): FleetQueueEligibility {
  const cooldownMs = configCooldownMs(cfg) ?? DEFAULT_COOLDOWN_MS;
  const nowMs = Date.now();
  const workedEvents = selectWorkQueueCoordinator(cfg).readWorkedEvents();
  const repairQueue = (() => {
    try {
      return readGeneratedRepairQueueSnapshot();
    } catch {
      return null;
    }
  })();

  const blockingPendingProposals = blockingPendingProposalsForBacklog(pendingProposals, cfg);
  const pendingItemKeys = pendingProposalItemKeysForBacklog(items, blockingPendingProposals);
  const eligibleItems: WorkItem[] = [];
  let cooldownItems = 0;
  let pendingItems = 0;
  let repairRouteBlockedItems = 0;
  let repairControlBlockedItems = 0;
  let repairLifecycleUnavailableItems = 0;
  let repairTerminalItems = 0;
  let repairQuarantinedItems = 0;
  let trustedRouteItems = 0;
  let feasibleRouteItems = 0;
  let requiresAlternativeItems = 0;
  const routeReasons = new Map<GeneratedRepairRouteReason, number>();
  const blockedRouteItems: NonNullable<FleetGeneratedRepairRouteStatus['blockedItems']> = [];
  const recordRouteBlock = (
    item: WorkItem,
    reason: Exclude<GeneratedRepairRouteReason, 'feasible'>,
  ): void => {
    repairRouteBlockedItems++;
    routeReasons.set(reason, (routeReasons.get(reason) ?? 0) + 1);
    blockedRouteItems.push({ itemId: boundedRepairRouteItemId(item.id), reason });
  };
  const recordInspectionUnavailable = (item: WorkItem): void => {
    trustedRouteItems++;
    recordRouteBlock(item, 'inspection-unavailable');
  };
  let nextEligibleMs: number | null = null;
  for (const item of items) {
    if (!repairControlAvailable && item.tags.includes('proposal-repair')) {
      repairControlBlockedItems++;
      continue;
    }
    let repairDispatch: GeneratedRepairDispatchState | undefined;
    try {
      repairDispatch = repairQueue?.dispatchState(item);
    } catch {
      if (isTrustedGeneratedRepairItem(item)) {
        recordInspectionUnavailable(item);
        continue;
      }
      if (item.tags.includes('proposal-repair')) {
        repairControlBlockedItems++;
        continue;
      }
    }
    if (repairDispatch?.applies && !repairDispatch.dispatchable) {
      repairControlBlockedItems++;
      if (repairDispatch.state === 'lifecycle-unavailable') {
        repairLifecycleUnavailableItems++;
      } else {
        repairTerminalItems++;
        if (repairDispatch.disposition === 'quarantined') repairQuarantinedItems++;
      }
      continue;
    }
    if (pendingItemKeys.has(workItemCoverageKey(item))) {
      pendingItems++;
      continue;
    }
    let cooldownKeys: string[];
    try {
      cooldownKeys = repairQueue?.cooldownKeys(item) ?? [item.id];
    } catch {
      if (isTrustedGeneratedRepairItem(item)) {
        recordInspectionUnavailable(item);
        continue;
      }
      if (item.tags.includes('proposal-repair')) {
        repairControlBlockedItems++;
        continue;
      }
      cooldownKeys = [item.id];
    }
    const lastEvent = latestWorkedEventForKeys(workedEvents, cooldownKeys);
    const lastMs = lastEvent ? Date.parse(lastEvent.ts) : Number.NaN;
    const last = lastEvent && Number.isFinite(lastMs)
      ? { event: lastEvent, tsMs: lastMs, suppressible: isSuppressibleWorkedOutcome(lastEvent.outcome) }
      : undefined;
    const itemCooldownMs = cooldownMsForWorkItem(item, cooldownMs, last?.event);
    const cooldownUntil = last && last.suppressible ? last.tsMs + itemCooldownMs : null;
    if (cooldownUntil !== null && cooldownUntil > nowMs) {
      cooldownItems++;
      if (nextEligibleMs === null || cooldownUntil < nextEligibleMs) {
        nextEligibleMs = cooldownUntil;
      }
      continue;
    }
    if (isTrustedGeneratedRepairItem(item)) {
      trustedRouteItems++;
      if (repairQueue === null) {
        recordRouteBlock(item, 'inspection-unavailable');
        continue;
      }
      let route: GeneratedRepairRouteFeasibility;
      try {
        const policy = repairQueue.retryPolicy(item);
        route = inspectGeneratedRepairRouteFeasibility(item, cfg, policy);
      } catch {
        recordRouteBlock(item, 'inspection-unavailable');
        continue;
      }
      if (route.requiresAlternative) requiresAlternativeItems++;
      if (!route.feasible) {
        const reason = route.reason === 'feasible' ? 'inspection-unavailable' : route.reason;
        recordRouteBlock(item, reason);
        continue;
      }
      feasibleRouteItems++;
      routeReasons.set(route.reason, (routeReasons.get(route.reason) ?? 0) + 1);
    }
    eligibleItems.push(item);
  }

  const sortedBlockedRouteItems = blockedRouteItems
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  const visibleBlockedRouteItems = sortedBlockedRouteItems
    .slice(0, MAX_GENERATED_REPAIR_ROUTE_BLOCKED_ITEMS);
  const blockedItemsOmitted = sortedBlockedRouteItems.length - visibleBlockedRouteItems.length;

  return {
    eligibleItems,
    cooldownItems,
    pendingItems,
    repairRouteBlockedItems,
    repairControlBlockedItems,
    repairLifecycleUnavailableItems,
    repairTerminalItems,
    repairQuarantinedItems,
    ...(trustedRouteItems > 0 ? {
      generatedRepairRoutes: {
        scope: 'eligible-claim-candidates' as const,
        authority: 'observation-only' as const,
        trustedItems: trustedRouteItems,
        feasibleItems: feasibleRouteItems,
        unavailableItems: trustedRouteItems - feasibleRouteItems,
        requiresAlternativeItems,
        byReason: [...routeReasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
        ...(visibleBlockedRouteItems.length > 0 ? {
          blockedItems: visibleBlockedRouteItems,
        } : {}),
        ...(blockedItemsOmitted > 0 ? { blockedItemsOmitted } : {}),
      },
    } : {}),
    nextEligibleAt: isoFromMs(nextEligibleMs),
  };
}

function cooldownMsForWorkItem(
  item: WorkItem,
  baseCooldownMs: number,
  latestEvent?: WorkedEvent,
): number {
  if (latestEvent?.outcome === 'dispatch-blocked' && isTrustedGeneratedRepairItem(item)) {
    return Math.min(baseCooldownMs, GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS);
  }
  return baseCooldownMs;
}

/**
 * Build a read-only snapshot of the fleet. Async because the backlog scan is
 * async. NEVER throws - each source is independently guarded.
 */
export function laneGoalSourceQuality(read: ListGoalsDetailedResult): FleetLaneLockSourceQualityPart {
  const reasons: FleetLaneLockSourceReason[] = [];
  if (!read.complete) reasons.push('goals-incomplete');
  if (read.unreadableFiles > 0) reasons.push('goals-unreadable');
  if (read.limitExceeded) reasons.push('goals-limit-exceeded');
  const complete = read.complete && read.unreadableFiles === 0 && !read.limitExceeded;
  return {
    // The goal store defines an absent directory as an authoritative empty read.
    sourceState: complete ? 'healthy' : 'degraded',
    complete,
    reasons,
  };
}

export function laneEnrollmentSourceQuality(
  state: 'ready' | 'degraded',
): FleetLaneLockSourceQualityPart {
  return state === 'ready'
    ? { sourceState: 'healthy', complete: true, reasons: [] }
    : { sourceState: 'degraded', complete: false, reasons: ['enrollment-degraded'] };
}

export function laneProposalSourceQuality(
  read: NonNullable<FleetStatus['proposals']['sourceQuality']>,
): FleetLaneLockSourceQualityPart {
  const reasons: FleetLaneLockSourceReason[] = [];
  if (!read.complete) reasons.push('proposals-incomplete');
  if (read.invalidFiles > 0) reasons.push('proposals-invalid');
  if (read.unreadableFiles > 0) reasons.push('proposals-unreadable');
  if (read.stopReasons.some((reason) => reason.includes('limit'))) reasons.push('proposals-limit-exceeded');
  const complete = read.complete && read.invalidFiles === 0 && read.unreadableFiles === 0 &&
    !read.stopReasons.some((reason) => reason.includes('limit'));
  return {
    // The inbox store also defines an absent directory as an authoritative empty read.
    sourceState: complete ? 'healthy' : 'degraded',
    complete,
    reasons,
  };
}

export function laneQueueSourceQuality(
  status: FleetReadinessSourceStatus,
  sources: FleetStatus['queue']['sources'],
  enrollmentState: 'ready' | 'degraded',
  enrolledRepoCount: number,
): FleetLaneLockSourceQualityPart {
  if (enrollmentState === 'degraded') {
    return {
      sourceState: 'degraded',
      complete: false,
      reasons: ['queue-incomplete', 'queue-unavailable'],
    };
  }
  if (enrolledRepoCount === 0) {
    return { sourceState: 'healthy', complete: true, reasons: [] };
  }
  const reasons: FleetLaneLockSourceReason[] = [];
  const parts = sources ? [sources.cachedBacklog, sources.queuedAutonomy] : [];
  if (parts.length === 0 || parts.some((part) => part.sourceState === 'missing')) reasons.push('queue-missing');
  if (status === 'degraded') reasons.push('queue-incomplete');
  if (parts.some((part) => part.sourceState === 'unavailable')) reasons.push('queue-unavailable');
  if (parts.some((part) => part.freshness === 'stale')) reasons.push('queue-stale');
  const sourceState: FleetLaneLockSourceQualityPart['sourceState'] =
    status === 'degraded' || reasons.includes('queue-unavailable') || reasons.includes('queue-stale')
      ? 'degraded'
      : status === 'healthy' && !reasons.includes('queue-missing')
        ? 'healthy'
        : 'missing';
  return {
    sourceState,
    complete: sourceState === 'healthy',
    reasons,
  };
}

export function buildRepoExecutionCoverage(enrolledRepos: ReadonlySet<string>): NonNullable<FleetQueueRepoCoverage['executionProfiles']> {
  let reposWithProjects = 0;
  let reposWithVerifyCommands = 0;
  let reposWithVerifyContracts = 0;
  let reposWithValidVerifyContracts = 0;
  let reposWithExplicitMergeContracts = 0;
  const packageManagers = new Map<RepoPackageManager, Set<string>>();
  const missingVerifyCommands: NonNullable<NonNullable<FleetQueueRepoCoverage['executionProfiles']>['missingVerifyCommands']> = [];
  const missingExplicitMergeContracts: NonNullable<NonNullable<FleetQueueRepoCoverage['executionProfiles']>['missingExplicitMergeContracts']> = [];

  for (const repo of enrolledRepos) {
    try {
      const profile = detectRepoExecutionProfile(repo);
      if (profile.projects.length > 0) reposWithProjects++;
      const projectKinds = [...new Set(profile.projects.map((project) => project.kind))].sort();
      if (profile.verifyCommands.length > 0) reposWithVerifyCommands++;
      else {
        missingVerifyCommands.push({
          repo,
          name: basename(repo),
          projectKinds,
          reason: profile.noVerifyReason ?? 'no detected verify commands',
        });
      }
      if (profile.verifyContract?.present) reposWithVerifyContracts++;
      if (profile.verifyContract?.valid) reposWithValidVerifyContracts++;
      if (profile.verifyContract?.mergeGradeExplicit && profile.verifyContractSource === 'tracked-clean') {
        reposWithExplicitMergeContracts++;
      }
      else {
        missingExplicitMergeContracts.push({
          repo,
          name: basename(repo),
          projectKinds,
          reason: profile.verifyContract?.mergeGradeExplicit
            ? `ashlr.verify.json is ${profile.verifyContractSource}; merge contract must be tracked-clean`
            : profile.verifyContract?.mergeGradeReason ?? 'missing ashlr.verify.json merge-profile contract',
        });
      }
      for (const project of profile.projects) {
        const repos = packageManagers.get(project.packageManager) ?? new Set<string>();
        repos.add(repo);
        packageManagers.set(project.packageManager, repos);
      }
    } catch {
      // Read-only observability only; a broken profile scan should not hide queue status.
      missingVerifyCommands.push({
        repo,
        name: basename(repo),
        projectKinds: [],
        reason: 'repo execution profile detection failed',
      });
      missingExplicitMergeContracts.push({
        repo,
        name: basename(repo),
        projectKinds: [],
        reason: 'repo execution profile detection failed',
      });
    }
  }

  const result: NonNullable<FleetQueueRepoCoverage['executionProfiles']> = {
    reposWithProjects,
    reposWithVerifyCommands,
    reposMissingVerifyCommands: Math.max(0, enrolledRepos.size - reposWithVerifyCommands),
    reposWithVerifyContracts,
    reposWithValidVerifyContracts,
    reposWithExplicitMergeContracts,
    reposMissingExplicitMergeContracts: Math.max(0, enrolledRepos.size - reposWithExplicitMergeContracts),
    packageManagers: [...packageManagers.entries()]
      .map(([manager, repos]) => ({ manager, repos: repos.size }))
      .sort((a, b) => b.repos - a.repos || a.manager.localeCompare(b.manager)),
  };
  if (missingVerifyCommands.length > 0) {
    result.missingVerifyCommands = missingVerifyCommands.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (missingExplicitMergeContracts.length > 0) {
    result.missingExplicitMergeContracts = missingExplicitMergeContracts.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}
