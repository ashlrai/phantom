/**
 * M49: fleet control plane + observability - read-only aggregation.
 *
 * `buildFleetStatus(cfg)` is a single READ-ONLY snapshot of the whole fleet:
 * the daemon's liveness + today's spend, per-backend recent dispatch counts and
 * quota status, the backlog queue size, the inbox proposal counts (pending /
 * frontier-pending / applied), recent auto-merges, and whether the global kill
 * switch is engaged.
 *
 * SAFETY: this NEVER mutates anything and NEVER throws. Every underlying source
 * is wrapped in its own try/catch with a sane fallback, so a single broken
 * source (corrupt daemon state, absent backlog, etc.) degrades only its own
 * slice - the rest of the snapshot still resolves. It adds NO capability: it
 * only reads what the daemon/quota/inbox/backlog modules already persist.
 */
// Public API: projections and types are re-exported from the status-* modules.

import type { AshlrConfig, EngineId, WorkItem, Proposal } from '../types.js';
import type {
  FleetStatus, FleetReadinessSourceStatus, FleetBackendStatus, FleetQueueNextItem,
  FleetGeneratedRepairRouteStatus, FleetQueueRepoCoverage, FleetQueueGeneratedWorkStatus,
  FleetQueueScannerEvidenceStatus, FleetResolutionObserverStatus, FleetQueueInventorySourceStatus,
  FleetSharedQueueStatus, FleetAutonomyStatus, FleetAutoMergeReadinessStatus, FleetGoalFocusStatus,
  FleetRepairHandoffRolloutStatus, FleetDetachedPostMergeVerificationReadiness,
} from './status-types.js';
import {
  type DispatchProductionEvent, readDispatchProductionYieldDetailed, type DispatchProductionSourceQuality,
} from './dispatch-production-ledger.js';
import {
  readFleetDaemonStatus, buildActiveWorkStatus, RECENT_WINDOW_MS, sumRecentBackend, attachBackendResources,
  buildSharedQueueStatus, buildAutonomyStatus, resolveAutonomyControlMode, buildDispatchManifestStatus,
  LEARNING_SNAPSHOT_SETTLE_MS, lightweightEcosystemReport, buildAutonomyDirectionSummary,
} from './status-sources.js';
import {
  buildDiagnosticResliceDrainStatus, mergeVisibleQueueItems, queueInventoryFreshness,
  buildQueueGeneratedWorkStatus, buildRepoExecutionCoverage, buildQueueEligibility,
  laneEnrollmentSourceQuality, laneGoalSourceQuality, laneProposalSourceQuality, laneQueueSourceQuality,
  repairHandoffProjectionTick, buildRepairHandoffRolloutStatus,
} from './status-queue.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import {
  validRepairHandoffV2Activation, type RepairHandoffSchemaSummary, readRepairHandoffSchemaSummary,
} from './repair-handoff-journal.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadQueuedAutonomyItemsDetailed } from '../portfolio/queued-autonomy.js';
import { type StrategicTier, strategicTierOfRepo } from '../ecosystem/focus.js';
import { readResolutionObserverStatus } from './resolution-observer.js';
import { realizedMergeOf } from '../inbox/realized-merge.js';
import type { GuardHealthDiagnosis } from '../daemon/guard-health.js';
import type { AutonomyEvidencePacksReadResult } from '../autonomy/evidence-pack.js';
import {
  proposalAuthoritySource, buildAutoMergeReadinessStatus, projectAutoMergeCanaryStatus,
  buildAutoMergeCanaryPromotionReadiness, degradedAutoMergeCanaryStatus,
} from './status-automerge.js';
import { type ListGoalsDetailedResult, listGoalsDetailed } from '../goals/store.js';
import { goalFocusSnapshot } from '../goals/focus.js';
import { createProposalMilestoneCompletionPredicate } from '../goals/completion.js';
import { type FleetLaneLocksStatus, buildFleetLaneLocks } from './lane-lock.js';
import { buildFleetPhantomStatus } from './status-phantom.js';
import { readBuildIdentity } from '../build-identity.js';
import { buildProposalProductionStatus } from './status-production.js';
import { readDecisionsDetailed } from './decisions-ledger.js';
import { readJudgeTracesDetailed } from './judge-trace.js';
import {
  buildProposalFunnelObservability, withholdProposalFunnelForUnstableSnapshot,
} from './proposal-funnel-observability.js';
import {
  learningSourceAvailability, learningMetricAvailability, learningSourceAvailable, projectPostMergeComposite,
  settledLearningRows, learningSnapshotTimestamp, learningSnapshotDigest, learningSnapshotSourceQuality,
  invalidatedDispatchProductionSource, withholdAttemptJoinMetrics, withholdTrajectoryMetrics,
  readSkillCorpusReadiness,
} from './status-learning.js';
import { buildDispatchYieldDiagnostics } from './status-dispatch-yield.js';
import { readBestOfNRecordsDetailed } from './best-of-n-ledger.js';
import { type PostMergeObservationReadResult, readPostMergeObservations } from './post-merge-observations.js';
import { readPostMergeStability } from './post-merge-stability.js';
import {
  type DetachedPostMergeWorkTicketReadResult, readDetachedPostMergeWorkTickets,
  readCurrentDetachedPostMergeDenominator, projectDetachedPostMergeDenominator,
} from './detached-post-merge-orchestrator.js';
import { readDetachedPostMergeVerificationCohorts } from './detached-post-merge-verification.js';
import { type WorkedLedgerReadResult, loadWorkedLedgerDetailed } from './worked-ledger.js';
import { type AgentWorkspaceReadResult, readAgentWorkspaceDetailed } from './agent-action-ledger.js';
import { type OutcomeRecord, listOutcomeRecords } from '../autonomy/outcome-records.js';
import {
  listAttemptRecords, type AttemptRecordCoverage, summarizeAttemptCoverage,
} from '../autonomy/attempt-records.js';
import { readSkillUseEventsWithDiagnostics } from './skill-records.js';
import {
  listTrajectoryRecords, type TrajectoryRecordCoverage, summarizeTrajectoryLearning,
  suppressDegradedSkillObservation,
} from '../autonomy/trajectory-records.js';
import { buildContextEfficiencyStatus } from './context-efficiency.js';
import { buildAutonomyEffectiveness, buildNextActions, buildMissionBrief } from './status-actions.js';
import { buildAutonomousShipReadiness } from './status-readiness.js';
import { readFleetCutoffCheckpointStatus } from './cutoff-observation-status.js';
import { evaluateAutoMergeCanaryPromotionReadiness } from './automerge-canary-promotion-readiness.js';

export async function buildFleetStatus(cfg: AshlrConfig): Promise<FleetStatus> {
  const generatedAt = new Date().toISOString();
  let dispatchLearningEvents: DispatchProductionEvent[] | undefined;
  let initialDispatchRead: ReturnType<typeof readDispatchProductionYieldDetailed> | undefined;
  let queueSnapshotAt: string | null = null;
  let queueAuthorityObservedAt: string | null = null;
  let queueSourceStatus: FleetReadinessSourceStatus = 'unknown';
  let queueSourceDetail = 'backlog snapshot has not been read yet';

  // ── daemon ────────────────────────────────────────────────────────────────
  const daemonRead = await readFleetDaemonStatus();
  const daemon = daemonRead.daemon;
  // Recent ticks are reused for merge counting below.
  const recentTicks = daemonRead.recentTicks;
  try {
    const { inspectDaemonActivationPermit } = await import('../daemon/activation-permit.js');
    daemon.activation = inspectDaemonActivationPermit(cfg, {
      once: true,
      dryRun: false,
    });
  } catch {
    daemon.activation = {
      schemaVersion: 1,
      policyVersion: 'm461-proposal-once-v1',
      authority: 'observation-only',
      sourceState: 'degraded',
      state: 'degraded',
      commandEligible: false,
      requestedShape: 'proposal-once',
      trustRootCount: 0,
      residentAuthorized: false,
      residentStandingAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
      reason: 'activation-readiness-unavailable',
    };
  }
  const diagnosticResliceDrain = buildDiagnosticResliceDrainStatus(recentTicks);
  const activeWork = await buildActiveWorkStatus();

  // ── backends ────────────────────────────────────────────────────────────────
  const allowed: EngineId[] = cfg.foundry?.allowedBackends ?? ['builtin'];
  const backends: FleetBackendStatus[] = [];
  for (const backend of allowed) {
    let dispatchesRecent = 0;
    let quota: FleetBackendStatus['quota'] = 'unlimited';
    try {
      const { usesInWindow, evalFleetQuotaAuthority } = await import('./quota.js');
      // quota.json is actual-attempt telemetry; quota-reservations.json is the
      // separate fail-closed launch authority. Never report a healthy quota
      // when strict authority state/config would refuse provider contact.
      dispatchesRecent = usesInWindow(backend, RECENT_WINDOW_MS);
      // Quota standing: 'unlimited' when no limit is configured for this backend.
      quota = evalFleetQuotaAuthority(backend, cfg);
    } catch {
      // Ledger unavailable - fall back to summing recent tick.backends counts.
      try {
        dispatchesRecent = sumRecentBackend(recentTicks, backend);
      } catch {
        dispatchesRecent = 0;
      }
      quota = cfg.foundry?.limits?.[backend] ? 'over' : 'unlimited';
    }
    backends.push({ backend, dispatchesRecent, quota });
  }
  // Use the same effective backend list as the displayed rows. The monitor's
  // default inventory is broader and may probe unrelated accounts or runtimes.
  const resourceConfig: AshlrConfig = {
    ...cfg,
    foundry: { ...cfg.foundry, allowedBackends: backends.map((row) => row.backend) },
  };
  try {
    await attachBackendResources(backends, resourceConfig);
  } catch {
    // Optional observability only; backend rows remain useful without resources.
  }

  // ── queue (backlog size) ──────────────────────────────────────────────────
  let backlogItems = 0;
  let visibleQueueItems: WorkItem[] = [];
  let actionableQueueItems: WorkItem[] = [];
  let nextQueueItems: FleetQueueNextItem[] = [];
  let eligibleBacklogItems = 0;
  let cooldownItems = 0;
  let pendingItems = 0;
  let repairRouteBlockedItems = 0;
  let repairControlBlockedItems = 0;
  let repairLifecycleUnavailableItems = 0;
  let repairTerminalItems = 0;
  let repairQuarantinedItems = 0;
  let generatedRepairRoutes: FleetGeneratedRepairRouteStatus | undefined;
  let eligibleOrdinaryItems: number | null = null;
  let nextEligibleAt: string | null = null;
  let queueRepos: FleetQueueRepoCoverage | undefined;
  let generatedWork: FleetQueueGeneratedWorkStatus | undefined;
  let queueInventorySources: FleetStatus['queue']['sources'];
  let scannerEvidence: FleetQueueScannerEvidenceStatus | undefined;
  let resolutionObserver: FleetResolutionObserverStatus | undefined;
  let enrolledExistingRepos: string[] = [];
  const enrollmentRegistry: {
    state: 'ready';
    repos: string[];
    reason: string;
  } | {
    state: 'degraded';
    reason: string;
  } = (() => {
    try {
      return readEnrollmentRegistry();
    } catch {
      return { state: 'degraded', reason: 'enrollment registry read failed' };
    }
  })();
  const repairHandoffWriterConfigured = cfg.foundry?.repairHandoffV2Write === true;
  const repairHandoffActivationRaw = (cfg.foundry as Record<string, unknown> | undefined)?.['repairHandoffV2Activation'];
  const repairHandoffActivation = validRepairHandoffV2Activation(repairHandoffActivationRaw)
    ? repairHandoffActivationRaw
    : undefined;
  let repairHandoffSummary: RepairHandoffSchemaSummary | undefined;
  try {
    repairHandoffSummary = readRepairHandoffSchemaSummary(repairHandoffActivation);
  } catch {
    repairHandoffSummary = undefined;
  }
  try {
    // Status must be observational. A full buildBacklog() refresh can run
    // scanners, expand planning goals, persist ~/.ashlr/backlog.json, and audit.
    // Read the last persisted snapshot only; the daemon/backlog CLI owns refresh.
    const { loadBacklog } = await import('../portfolio/backlog.js');
    const backlog = loadBacklog();
    queueSnapshotAt = typeof backlog?.generatedAt === 'string' ? backlog.generatedAt : null;
    if (Array.isArray(backlog?.observations)) {
      const present = backlog.observations.filter((observation) => observation.status === 'present').length;
      const absent = backlog.observations.filter((observation) => observation.status === 'absent').length;
      const unavailable = backlog.observations.filter((observation) => observation.status === 'unavailable').length;
      scannerEvidence = {
        state: backlog.observationSourceState === 'degraded' || backlog.observationsTruncated === true
          ? 'degraded'
          : backlog.observations.length === 0
            ? 'unknown'
            : unavailable > 0 ? 'degraded' : 'healthy',
        observations: backlog.observations.length,
        present,
        absent,
        unavailable,
        scannerDomains: new Set(backlog.observations.map((observation) => observation.scannerId)).size,
      };
    }
    const enrolledRaw = enrollmentRegistry.state === 'ready'
      ? enrollmentRegistry.repos.map((repo) => resolve(repo))
      : [];
    const enrolledRepos = new Set(enrolledRaw.filter((repo) => existsSync(repo)));
    enrolledExistingRepos = [...enrolledRepos];
    const nowMs = Date.now();
    const cachedItems = mergeVisibleQueueItems(
      Array.isArray(backlog?.items) ? backlog.items : [],
      enrolledRepos,
    );
    const cachedFreshness = backlog
      ? queueInventoryFreshness(queueSnapshotAt, nowMs)
      : 'unknown';
    const queuedRead = loadQueuedAutonomyItemsDetailed();
    const queuedItems = mergeVisibleQueueItems(queuedRead.items, enrolledRepos);
    // The strict queued-autonomy read is a live observation. Its loader already
    // applies daemon-equivalent intrinsic expiry while retaining generation-bound
    // repairs for their durable lifecycle, so item.ts must not become a second
    // source-freshness gate here.
    const queuedObservedAt = queuedRead.sourceState === 'complete' && queuedItems.length > 0
      ? generatedAt
      : null;
    const actionableQueuedItems = queuedRead.sourceState === 'complete' ? queuedItems : [];
    const queuedFreshness: FleetQueueInventorySourceStatus['freshness'] = queuedItems.length === 0
      ? queuedRead.sourceState === 'complete' ? 'empty' : 'unknown'
      : queuedRead.sourceState === 'complete' ? 'fresh' : 'unknown';
    const freshCachedItems = cachedFreshness === 'fresh' ? cachedItems : [];
    actionableQueueItems = mergeVisibleQueueItems(
      [...freshCachedItems, ...actionableQueuedItems],
      enrolledRepos,
    );
    const items = mergeVisibleQueueItems([...cachedItems, ...queuedItems], enrolledRepos);
    visibleQueueItems = items;
    backlogItems = items.length;
    generatedWork = buildQueueGeneratedWorkStatus(items);
    queueInventorySources = {
      cachedBacklog: {
        provenance: 'persisted-backlog',
        sourceState: backlog ? 'complete' : 'missing',
        freshness: backlog ? cachedFreshness : 'unknown',
        observedAt: queueSnapshotAt,
        visibleItems: cachedItems.length,
        actionableItems: freshCachedItems.length,
        detail: backlog
          ? `${cachedItems.length} enrolled item(s) in persisted backlog snapshot`
          : 'persisted backlog snapshot is missing or unreadable',
      },
      queuedAutonomy: {
        provenance: 'queued-autonomy',
        sourceState: queuedRead.sourceState,
        freshness: queuedFreshness,
        observedAt: queuedObservedAt,
        visibleItems: queuedItems.length,
        actionableItems: actionableQueuedItems.length,
        detail: queuedRead.sourceState === 'complete'
          ? `${actionableQueuedItems.length}/${queuedItems.length} queued autonomy item(s) passed daemon queue admission`
          : `queued autonomy source is unavailable (${queuedRead.filesUnavailable} file(s) unavailable)`,
      },
    };
    const observedTimestamps = [
      queueSnapshotAt,
      queuedObservedAt,
    ].filter((ts): ts is string => ts !== null && Number.isFinite(Date.parse(ts)));
    queueAuthorityObservedAt = observedTimestamps
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    const hasDegradedInventory =
      enrollmentRegistry.state === 'degraded' ||
      (Boolean(backlog) && cachedFreshness !== 'fresh') ||
      queuedRead.sourceState === 'unavailable';
    if (hasDegradedInventory) {
      queueSourceStatus = 'degraded';
    } else if (backlog || queuedItems.length > 0) {
      queueSourceStatus = 'healthy';
    } else if (queuedRead.sourceState === 'complete') {
      queueSourceStatus = 'unknown';
    } else {
      queueSourceStatus = 'unavailable';
    }
    queueSourceDetail = enrollmentRegistry.state === 'degraded'
      ? `enrollment authority degraded: ${enrollmentRegistry.reason}; queue inventory withheld`
      : `${items.length} visible queue item(s); ${actionableQueueItems.length} actionable from fresh sources; ` +
        `cached backlog ${queueInventorySources.cachedBacklog.freshness}; ` +
        `queued autonomy ${queueInventorySources.queuedAutonomy.freshness}`;
    if (enrollmentRegistry.state === 'degraded') {
      // The registry itself was observed during this snapshot. Its current
      // degraded result must not be mislabeled as an unknown or healthy-zero source.
      queueAuthorityObservedAt = generatedAt;
    }
    if (
      generatedWork &&
      generatedWork.diagnosticReslices > 0 &&
      diagnosticResliceDrain?.stalled === true
    ) {
      generatedWork = { ...generatedWork, diagnosticResliceDrainStalled: true };
    }
    const byRepo = new Map<string, number>();
    const byTier = new Map<StrategicTier, { repos: Set<string>; items: number }>();
    for (const item of items) {
      const key = resolve(item.repo);
      byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
      const tier = strategicTierOfRepo(key);
      const tierRow = byTier.get(tier) ?? { repos: new Set<string>(), items: 0 };
      tierRow.repos.add(key);
      tierRow.items++;
      byTier.set(tier, tierRow);
    }
    queueRepos = {
      enrolled: enrolledRaw.length,
      existing: enrolledRepos.size,
      withBacklog: byRepo.size,
      silent: Math.max(0, enrolledRepos.size - byRepo.size),
      ...(enrollmentRegistry.state === 'degraded'
        ? { registry: { state: 'degraded' as const, reason: enrollmentRegistry.reason } }
        : {}),
      executionProfiles: buildRepoExecutionCoverage(enrolledRepos),
      byTier: (['core-fleet', 'force-multiplier', 'inventory', 'supporting'] as StrategicTier[])
        .flatMap((tier) => {
          const row = byTier.get(tier);
          return row ? [{ tier, repos: row.repos.size, items: row.items }] : [];
        }),
      top: [...byRepo.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([repo, itemCount]) => ({ repo, items: itemCount })),
    };
  } catch {
    backlogItems = 0;
    visibleQueueItems = [];
    actionableQueueItems = [];
    nextQueueItems = [];
    queueSnapshotAt = null;
    queueAuthorityObservedAt = enrollmentRegistry.state === 'degraded' ? generatedAt : null;
    queueSourceStatus = enrollmentRegistry.state === 'degraded' ? 'degraded' : 'unavailable';
    queueSourceDetail = enrollmentRegistry.state === 'degraded'
      ? `enrollment authority degraded: ${enrollmentRegistry.reason}; queue inventory withheld`
      : 'queue source could not be read';
    queueRepos = enrollmentRegistry.state === 'degraded'
      ? {
          enrolled: 0,
          existing: 0,
          withBacklog: 0,
          silent: 0,
          registry: { state: 'degraded', reason: enrollmentRegistry.reason },
          top: [],
          byTier: [],
        }
      : undefined;
    queueInventorySources = {
      cachedBacklog: {
        provenance: 'persisted-backlog',
        sourceState: 'unavailable',
        freshness: 'unknown',
        observedAt: null,
        visibleItems: 0,
        actionableItems: 0,
        detail: 'persisted backlog source could not be read',
      },
      queuedAutonomy: {
        provenance: 'queued-autonomy',
        sourceState: 'unavailable',
        freshness: 'unknown',
        observedAt: null,
        visibleItems: 0,
        actionableItems: 0,
        detail: 'queued autonomy source could not be read',
      },
    };
  }

  try {
    const observer = readResolutionObserverStatus();
    const queueMs = queueSnapshotAt ? Date.parse(queueSnapshotAt) : NaN;
    const observerMs = observer.lastBacklogAt ? Date.parse(observer.lastBacklogAt) : NaN;
    const lagMs = Number.isFinite(queueMs) && Number.isFinite(observerMs)
      ? Math.max(0, queueMs - observerMs)
      : null;
    const freshness: FleetResolutionObserverStatus['freshness'] =
      observer.state === 'degraded'
        ? 'degraded'
        : observer.state === 'missing' || !queueSnapshotAt || !observer.lastBacklogAt
          ? 'missing'
          : observerMs > queueMs
            ? 'degraded'
            : observer.lastBacklogAt === queueSnapshotAt
            ? 'current'
            : 'stale';
    resolutionObserver = { ...observer, freshness, lagMs };
  } catch {
    resolutionObserver = {
      state: 'degraded',
      checkpointState: 'degraded',
      runState: 'degraded',
      witnessState: 'degraded',
      freshness: 'degraded',
      lagMs: null,
      lastRunAt: null,
      lastBacklogAt: null,
      lastOutcome: null,
      pendingObjectives: 0,
      witnesses: 0,
      latestWitnessAt: null,
      invalidRows: 1,
      conflictingWitnesses: 0,
    };
  }

  let sharedQueue: FleetSharedQueueStatus | undefined;
  try {
    sharedQueue = await buildSharedQueueStatus(cfg);
  } catch {
    sharedQueue = undefined;
  }

  // ── proposals (pending / frontier-pending / applied) ──────────────────────
  let pending = 0;
  let frontierPending = 0;
  let awaitingHostMerge = 0;
  let applied = 0;
  const allProposals: Proposal[] = [];
  const pendingProposals: Proposal[] = [];
  let proposalSourceQuality: NonNullable<FleetStatus['merges']['sourceQuality']> = {
    sourceState: 'degraded',
    sourcePresent: false,
    complete: false,
    stopReasons: ['source-not-read'],
    filesDiscovered: 0,
    filesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  };
  let proposalsSnapshotForLearning:
    ReturnType<typeof import('../inbox/store.js')['listProposalsDetailed']> | undefined;
  try {
    const { listProposalsDetailed } = await import('../inbox/store.js');
    const read = listProposalsDetailed();
    // Retained for the learning-authority inspection below: it must see the
    // SAME proposals snapshot this status build projected, not issue its own
    // mid-snapshot read (which tears the stability contract and doubles I/O).
    proposalsSnapshotForLearning = read;
    proposalSourceQuality = {
      sourceState: read.sourceState,
      sourcePresent: read.sourcePresent,
      complete: read.complete,
      stopReasons: [...read.stopReasons],
      filesDiscovered: read.filesDiscovered,
      filesRead: read.filesRead,
      invalidFiles: read.invalidFiles,
      unreadableFiles: read.unreadableFiles,
    };
    const all = read.proposals;
    for (const p of all) {
      allProposals.push(p);
      if (p.status === 'pending') {
        pending++;
        pendingProposals.push(p);
        if (p.engineTier === 'frontier') frontierPending++;
      } else if (p.status === 'applied') {
        applied++;
      } else if (p.status === 'awaiting-host-merge') {
        awaitingHostMerge++;
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    awaitingHostMerge = 0;
    applied = 0;
    proposalSourceQuality = {
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      stopReasons: ['source-read-failed'],
      filesDiscovered: 0,
      filesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
    };
  }

  try {
    const eligibility = buildQueueEligibility(
      actionableQueueItems,
      pendingProposals,
      cfg,
      repairHandoffSummary !== undefined &&
        repairHandoffSummary.sourceState !== 'degraded' &&
        (cfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'] !== false &&
        cfg.fleet?.sharedQueue?.mode !== 'filesystem',
    );
    eligibleBacklogItems = eligibility.eligibleItems.length;
    cooldownItems = eligibility.cooldownItems;
    pendingItems = eligibility.pendingItems;
    repairRouteBlockedItems = eligibility.repairRouteBlockedItems;
    repairControlBlockedItems = eligibility.repairControlBlockedItems;
    repairLifecycleUnavailableItems = eligibility.repairLifecycleUnavailableItems;
    repairTerminalItems = eligibility.repairTerminalItems;
    repairQuarantinedItems = eligibility.repairQuarantinedItems;
    generatedRepairRoutes = eligibility.generatedRepairRoutes;
    eligibleOrdinaryItems = queueSourceStatus === 'unknown' || queueSourceStatus === 'unavailable'
      ? null
      : eligibility.eligibleItems.filter((item) => !item.tags.includes('proposal-repair')).length;
    nextEligibleAt = eligibility.nextEligibleAt;
    nextQueueItems = eligibility.eligibleItems
      .slice()
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        title: item.title,
        repo: item.repo,
        source: item.source,
        score: item.score,
      }));
  } catch {
    eligibleBacklogItems = 0;
    cooldownItems = 0;
    pendingItems = 0;
    nextEligibleAt = null;
  }

  // ── merges (authenticated realized proposal witnesses only) ───────────────
  let mergesRecent = 0;
  let mergesReportedByTicks = 0;
  try {
    const now = Date.now();
    const cutoff = now - RECENT_WINDOW_MS;
    const counted = new Set<string>();
    for (const proposal of allProposals) {
      if (counted.has(proposal.id)) continue;
      const evidence = realizedMergeOf(proposal);
      if (!evidence) continue;
      const observedAt = evidence.source === 'local-default-branch'
        ? evidence.observedAt
        : evidence.reconciliation.observedAt;
      const observedMs = Date.parse(observedAt);
      if (!Number.isFinite(observedMs) || observedMs < cutoff || observedMs > now) continue;
      counted.add(proposal.id);
      mergesRecent++;
    }

    // Preserve tick aggregates as explicitly non-authoritative forensic data.
    for (const t of recentTicks) {
      if (typeof t.merged !== 'number' || t.merged <= 0) continue;
      mergesReportedByTicks = Math.min(
        Number.MAX_SAFE_INTEGER,
        mergesReportedByTicks + Math.floor(t.merged),
      );
    }
  } catch {
    mergesRecent = 0;
    mergesReportedByTicks = 0;
  }

  // ── kill switch ───────────────────────────────────────────────────────────
  let killed = true;
  let killSwitch: NonNullable<FleetStatus['killSwitch']> = {
    state: 'unknown',
    sourceState: 'degraded',
    reason: 'unavailable',
  };
  try {
    const { readKillSwitch } = await import('../sandbox/policy.js');
    const read = readKillSwitch();
    killSwitch = {
      state: read.state,
      sourceState: read.sourceState,
      reason: read.reason,
    };
    killed = read.state !== 'inactive';
  } catch {
    // Restrictive fallback: unobservable authority remains paused.
  }

  // ── guard health / state repair UX ──────────────────────────────────────
  let guardHealth: GuardHealthDiagnosis | undefined;
  try {
    const { diagnoseGuardHealth } = await import('../daemon/guard-health.js');
    guardHealth = diagnoseGuardHealth();
  } catch {
    guardHealth = {
      generatedAt,
      blocked: true,
      blocks: [],
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reasons: ['guard-health-unavailable'],
      },
    };
  }

  // ── autonomy evidence packs ──────────────────────────────────────────────
  let autonomy: FleetAutonomyStatus = {
    evidencePacks: 0,
    latestAt: null,
    allowed: 0,
    denied: 0,
    byTier: {},
    recent: [],
    authorityState: 'degraded',
    protocols: { sealedV3: 0, legacy: 0 },
    sourceQuality: {
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
      limitExceeded: false,
    },
  };
  let learningEvidenceRead: AutonomyEvidencePacksReadResult | undefined;
  try {
    const { readAutonomyEvidencePacksDetailed } = await import('../autonomy/evidence-pack.js');
    const evidenceRead = readAutonomyEvidencePacksDetailed(Number.MAX_SAFE_INTEGER);
    learningEvidenceRead = evidenceRead;
    autonomy = buildAutonomyStatus(evidenceRead.packs, evidenceRead);
  } catch {
    // leave fallback
  }

  let autoMergeReadiness: FleetAutoMergeReadinessStatus | undefined;
  const proposalAuthority = proposalAuthoritySource(proposalSourceQuality);
  // Preserve configuration/protection diagnostics for a pristine empty store,
  // while keeping its proposal authority explicitly unavailable. Degraded or
  // partial stores with observed rows remain fully withheld.
  if (proposalAuthority.gate === 'ready' || proposalSourceQuality.sourceState === 'missing') {
    try {
      autoMergeReadiness = await buildAutoMergeReadinessStatus(
        cfg,
        pendingProposals,
        enrolledExistingRepos,
        enrollmentRegistry,
      );
    } catch {
      autoMergeReadiness = undefined;
    }
  }

  let goalFocus: FleetGoalFocusStatus | undefined;
  let goalRead: ListGoalsDetailedResult = {
    goals: [],
    sourceState: 'degraded',
    sourcePresent: false,
    complete: false,
    scannedFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
  };
  try {
    goalRead = listGoalsDetailed();
    const goals = goalRead.goals.filter((goal) => goal.status === 'active' || goal.status === 'planning');
    const snapshot = goalFocusSnapshot(goals, cfg, {
      repos: enrolledExistingRepos,
      isMilestoneComplete: createProposalMilestoneCompletionPredicate(),
    });
    goalFocus = {
      enabled: snapshot.enabled,
      activeThreshold: snapshot.activeThreshold,
      activeGoalCount: snapshot.activeGoalCount,
      actionableActiveGoalCount: snapshot.actionableActiveGoalCount,
      planningGoalCount: snapshot.planningGoalCount,
      deferredNewGoalWork: snapshot.shouldDeferNewGoalWork,
      reason: snapshot.reason,
      visibleGoalBacklogItems: visibleQueueItems.filter((item) => item.source === 'goal').length,
      visibleInventBacklogItems: visibleQueueItems.filter((item) => item.source === 'invent').length,
    };
  } catch {
    goalFocus = undefined;
  }

  let laneLocks: FleetLaneLocksStatus | undefined;
  try {
    const enrolledRepoSet = new Set(enrolledExistingRepos);
    const laneGoals = goalRead.goals.filter(
      (goal) => goal.project !== null && enrolledRepoSet.has(resolve(goal.project)),
    );
    const laneProposals = allProposals.filter(
      (proposal) => proposal.repo === null || enrolledRepoSet.has(resolve(proposal.repo)),
    );
    laneLocks = buildFleetLaneLocks({
      goals: laneGoals,
      proposals: laneProposals,
      visibleQueueItems,
      generatedAt,
      sourceQuality: {
        enrollment: laneEnrollmentSourceQuality(enrollmentRegistry.state),
        goals: laneGoalSourceQuality(goalRead),
        proposals: laneProposalSourceQuality(proposalSourceQuality),
        queue: laneQueueSourceQuality(
          queueSourceStatus,
          queueInventorySources,
          enrollmentRegistry.state,
          enrolledExistingRepos.length,
        ),
      },
    });
  } catch {
    laneLocks = buildFleetLaneLocks({
      goals: [],
      proposals: [],
      visibleQueueItems: [],
      generatedAt,
      sourceQuality: {
        enrollment: { sourceState: 'degraded', complete: false, reasons: ['enrollment-degraded'] },
        goals: { sourceState: 'degraded', complete: false, reasons: ['goals-incomplete'] },
        proposals: { sourceState: 'degraded', complete: false, reasons: ['proposals-incomplete'] },
        queue: { sourceState: 'degraded', complete: false, reasons: ['queue-unavailable'] },
      },
    });
  }

  const phantom = await buildFleetPhantomStatus(cfg);

  let repairHandoffRollout: FleetRepairHandoffRolloutStatus;
  if (repairHandoffSummary !== undefined) {
    const summary = repairHandoffSummary;
    const sharedQueueIncompatible = cfg.fleet?.sharedQueue?.mode === 'filesystem';
    const writerBlockedReason: FleetRepairHandoffRolloutStatus['writerBlockedReason'] = !repairHandoffWriterConfigured
      ? null
      : !repairHandoffActivation
        ? 'missing-activation'
        : Date.parse(repairHandoffActivation.activatedAt) > Date.parse(generatedAt)
          ? 'activation-in-future'
        : sharedQueueIncompatible
          ? 'shared-queue-filesystem'
          : summary.sourceState === 'degraded' || summary.limitExceeded
            ? 'source-degraded'
            : null;
    const writerEffective = repairHandoffWriterConfigured && writerBlockedReason === null;
    const projectionTickAt = writerEffective && summary.currentActivationV2Authorities > 0
      ? repairHandoffProjectionTick(
          recentTicks,
          summary.authorityDigest,
          summary.latestCurrentActivationV2At ?? repairHandoffActivation!.activatedAt,
          {
            id: repairHandoffActivation!.id,
            activatedAt: repairHandoffActivation!.activatedAt,
            authorities: summary.currentActivationV2Authorities,
            authorityDigest: summary.currentActivationAuthorityDigest!,
          },
        )
      : null;
    repairHandoffRollout = buildRepairHandoffRolloutStatus(
      summary,
      repairHandoffWriterConfigured,
      eligibleOrdinaryItems,
      projectionTickAt,
      {
        activationAware: true,
        effective: writerEffective,
        blockedReason: writerBlockedReason,
        ...(repairHandoffActivation ? { activation: repairHandoffActivation } : {}),
      },
    );
  } else {
    repairHandoffRollout = {
      summaryAvailable: false,
      writerConfigured: repairHandoffWriterConfigured,
      writerEnabled: repairHandoffWriterConfigured,
      writerEffective: false,
      writerBlockedReason: 'source-degraded',
      activationId: repairHandoffActivation?.id ?? null,
      activatedAt: repairHandoffActivation?.activatedAt ?? null,
      phase: 'degraded',
      sourceState: 'degraded',
      v1Authorities: null,
      v2Authorities: null,
      v1PhysicalRows: null,
      v2PhysicalRows: null,
      invalidRows: null,
      conflictingIds: null,
      limitExceeded: null,
      aliasFamilies: null,
      latestV2At: null,
      currentActivationV2Authorities: null,
      unboundV2Authorities: null,
      latestCurrentActivationV2At: null,
      authorityDigest: null,
      projectionObserved: false,
      projectionTickAt: null,
      eligibleOrdinaryItems,
      action: repairHandoffWriterConfigured ? 'rollback-writer' : 'inspect-source',
    };
  }

  const status: FleetStatus = {
    generatedAt,
    buildIdentity: readBuildIdentity(),
    daemon,
    backends,
    queue: {
      backlogItems,
      eligibleBacklogItems,
      cooldownItems,
      pendingItems,
      ...(repairRouteBlockedItems > 0 ? { repairRouteBlockedItems } : {}),
      ...(repairControlBlockedItems > 0 ? { repairControlBlockedItems } : {}),
      ...(repairLifecycleUnavailableItems > 0 ? { repairLifecycleUnavailableItems } : {}),
      ...(repairTerminalItems > 0 ? { repairTerminalItems } : {}),
      ...(repairQuarantinedItems > 0 ? { repairQuarantinedItems } : {}),
      nextEligibleAt,
      ...(queueRepos !== undefined ? { repos: queueRepos } : {}),
      ...(nextQueueItems.length > 0 ? { next: nextQueueItems } : {}),
      ...(queueInventorySources !== undefined ? { sources: queueInventorySources } : {}),
      ...(sharedQueue !== undefined ? { shared: sharedQueue } : {}),
      ...(activeWork !== undefined ? { activeWork } : {}),
      ...(generatedWork !== undefined ? { generatedWork } : {}),
      ...(generatedRepairRoutes !== undefined ? { generatedRepairRoutes } : {}),
      ...(scannerEvidence !== undefined ? { scannerEvidence } : {}),
      ...(resolutionObserver !== undefined ? { resolutionObserver } : {}),
      ...(diagnosticResliceDrain !== undefined ? { diagnosticResliceDrain } : {}),
    },
    ...(repairHandoffRollout !== undefined ? { repairHandoffRollout } : {}),
    proposals: {
      pending,
      frontierPending,
      ...(awaitingHostMerge > 0 ? { awaitingHostMerge } : {}),
      applied,
      sourceQuality: proposalSourceQuality,
      authority: proposalAuthority,
    },
    merges: {
      recent: mergesRecent,
      reportedByTicks: mergesReportedByTicks,
      sourceQuality: proposalSourceQuality,
    },
    ...(phantom !== undefined ? { phantom } : {}),
    autonomy,
    autonomyControlMode: resolveAutonomyControlMode(cfg),
    evidencePolicy: {
      concurrentDispatchEnabled: cfg.foundry?.fabric?.concurrentDispatch === true,
      bestOfNEnabled: (cfg.foundry?.bestOfN ?? 1) > 1,
    },
    ...(autoMergeReadiness !== undefined ? { autoMergeReadiness } : {}),
    ...(guardHealth !== undefined ? { guardHealth } : {}),
    ...(goalFocus !== undefined ? { goalFocus } : {}),
    ...(laneLocks !== undefined ? { laneLocks } : {}),
    killed,
    killSwitch,
  };
  const proposalProduction = buildProposalProductionStatus(recentTicks);
  if (proposalProduction) status.proposalProduction = proposalProduction;
  let learningDecisionsRead: ReturnType<typeof readDecisionsDetailed> | undefined;
  try {
    const decisionsRead = readDecisionsDetailed();
    learningDecisionsRead = decisionsRead;
    status.decisionsSource = {
      sourceState: decisionsRead.sourceState,
      sourcePresent: decisionsRead.sourcePresent,
      complete: decisionsRead.complete,
      stopReasons: decisionsRead.stopReasons,
      filesRead: decisionsRead.filesRead,
      bytesRead: decisionsRead.bytesRead,
      rowsScanned: decisionsRead.rowsScanned,
      invalidRows: decisionsRead.invalidRows,
      unreadableFiles: decisionsRead.unreadableFiles,
    };
  } catch {
    status.decisionsSource = {
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
      filesRead: 0,
      bytesRead: 0,
      rowsScanned: 0,
      invalidRows: 0,
      unreadableFiles: 1,
    };
  }
  try {
    const { inspectRoutingLearningAuthority } = await import('../run/learned-router.js');
    status.routingLearningAuthority = inspectRoutingLearningAuthority(
      undefined,
      undefined,
      { proposalsRead: proposalsSnapshotForLearning },
    );
  } catch {
    status.routingLearningAuthority = {
      version: 1,
      state: 'inactive',
      operationalSteering: false,
      sourceQuality: {
        decisions: {
          sourceState: 'degraded', sourcePresent: true, complete: false, authenticated: false,
        },
        assignments: {
          sourceState: 'degraded', sourcePresent: true, complete: false,
          denominatorComplete: false, authenticated: false,
        },
      },
      samples: { observed: 0, eligible: 0, minimumPerStratum: 5 },
      cohort: { policyVersion: null, learningEpoch: null },
      blockerCodes: [
        'assignment-authenticity-unavailable',
        'assignment-denominator-incomplete',
        'assignment-source-degraded',
        'decision-authenticity-unavailable',
        'decision-source-degraded',
        'sample-floor-unmet',
      ],
    };
  }
  let learningJudgeTracesRead: ReturnType<typeof readJudgeTracesDetailed> | undefined;
  try {
    const traceRead = readJudgeTracesDetailed();
    learningJudgeTracesRead = traceRead;
    status.judgeTraceSource = {
      sourceState: traceRead.sourceState,
      sourcePresent: traceRead.sourcePresent,
      complete: traceRead.complete,
      stopReasons: traceRead.stopReasons,
      filesRead: traceRead.filesRead,
      bytesRead: traceRead.bytesRead,
      rowsScanned: traceRead.rowsScanned,
      invalidRows: traceRead.invalidRows,
      unreadableFiles: traceRead.unreadableFiles,
    };
  } catch {
    status.judgeTraceSource = {
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
      filesRead: 0,
      bytesRead: 0,
      rowsScanned: 0,
      invalidRows: 0,
      unreadableFiles: 1,
    };
  }
  try {
    const dispatchRead = readDispatchProductionYieldDetailed({
      windowMs: RECENT_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 8,
    });
    initialDispatchRead = dispatchRead;
    status.dispatchProductionSource = dispatchRead.sourceQuality;
    status.proposalFunnel = buildProposalFunnelObservability({
      events: dispatchRead.events,
      sourceQuality: dispatchRead.sourceQuality,
      windowMs: RECENT_WINDOW_MS,
      eventLimit: 1200,
    });
    const dispatchAvailabilitySource = learningSourceAvailability(
      'dispatch-production', dispatchRead.sourceQuality,
    );
    const dispatchProductionAvailability = learningMetricAvailability(
      [dispatchAvailabilitySource],
      learningSourceAvailable(dispatchAvailabilitySource) ? [] : ['dispatchProduction'],
      1,
    );
    status.learningMetrics = dispatchRead.sourceQuality.sourceState === 'healthy' && dispatchRead.sourceQuality.complete
      ? {
          state: 'available',
          denominator: 'dispatch-production',
          sourceQuality: dispatchRead.sourceQuality,
          dispatchProduction: dispatchProductionAvailability,
        }
      : {
          state: 'withheld',
          denominator: 'dispatch-production',
          reason: dispatchRead.sourceQuality.sourceState === 'missing'
            ? 'dispatch-source-missing'
            : 'dispatch-source-degraded',
          sourceQuality: dispatchRead.sourceQuality,
          dispatchProduction: dispatchProductionAvailability,
        };
    if (status.learningMetrics.state === 'available') {
      dispatchLearningEvents = dispatchRead.events;
    }
    const dispatchProduction = dispatchRead.summary;
    if (dispatchProduction) {
      status.dispatchProduction = dispatchProduction;
      if (dispatchRead.sourceQuality.sourceState === 'healthy' && dispatchRead.sourceQuality.complete) {
        status.dispatchYieldDiagnostics = buildDispatchYieldDiagnostics(dispatchProduction, cfg, backends);
      }
    }
  } catch {
    const sourceQuality: DispatchProductionSourceQuality = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, datedFilesRead: 0, looseFilesRead: 0,
      bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 1,
    };
    status.dispatchProductionSource = sourceQuality;
    status.proposalFunnel = buildProposalFunnelObservability({
      events: [],
      sourceQuality,
      windowMs: RECENT_WINDOW_MS,
      eventLimit: 1200,
    });
    status.learningMetrics = {
      state: 'withheld',
      denominator: 'dispatch-production',
      reason: 'dispatch-source-degraded',
      sourceQuality,
      dispatchProduction: learningMetricAvailability(
        [learningSourceAvailability('dispatch-production', sourceQuality)],
        ['dispatchProduction'],
        1,
      ),
    };
  }
  try {
    const dispatchManifests = await buildDispatchManifestStatus();
    status.dispatchManifestSource = dispatchManifests.sourceQuality;
    if (dispatchManifests.summary) status.dispatchManifests = dispatchManifests.summary;
  } catch {
    // Optional forensic manifest surface only.
  }
  if (status.evidencePolicy?.bestOfNEnabled === true) {
    try {
      const bestOfN = readBestOfNRecordsDetailed({
        sinceMs: Date.parse(generatedAt) - 30 * 24 * 60 * 60 * 1000,
        limit: 100_000,
        maxFiles: 31,
        maxBytes: 32 * 1024 * 1024,
        maxRows: 100_000,
      });
      status.bestOfNSource = {
        sourceState: bestOfN.sourceState,
        sourcePresent: bestOfN.sourcePresent,
        complete: bestOfN.complete,
        stopReasons: bestOfN.stopReasons,
        filesRead: bestOfN.filesRead,
        bytesRead: bestOfN.bytesRead,
        rowsScanned: bestOfN.rowsScanned,
        invalidRows: bestOfN.invalidRows,
        unreadableFiles: bestOfN.unreadableFiles,
      };
    } catch {
      status.bestOfNSource = {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
        invalidRows: 0, unreadableFiles: 1,
      };
    }
  }
  let learningPostMergeRead: PostMergeObservationReadResult | undefined;
  try {
    const adverse = readPostMergeObservations({ requireComplete: true });
    learningPostMergeRead = adverse;
    const stability = readPostMergeStability({ requireComplete: true });
    const projection = projectPostMergeComposite(adverse, stability);
    status.postMergeSource = projection.source;
    if (projection.cohort) status.postMergeCohort = projection.cohort;
  } catch {
    status.postMergeSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
  }
  let detachedTickets: DetachedPostMergeWorkTicketReadResult | null = null;
  try {
    detachedTickets = readDetachedPostMergeWorkTickets({ requireComplete: true });
    status.detachedPostMergeWorkTicketSource = {
      sourceState: detachedTickets.sourceState,
      sourcePresent: detachedTickets.sourcePresent,
      complete: detachedTickets.complete,
      stopReasons: detachedTickets.stopReasons,
      filesRead: detachedTickets.filesRead,
      bytesRead: detachedTickets.bytesRead,
      rowsScanned: detachedTickets.tickets.length,
      invalidRows: detachedTickets.invalidFiles,
      unreadableFiles: detachedTickets.stopReasons.includes('io-error') ? 1 : 0,
    };
  } catch {
    status.detachedPostMergeWorkTicketSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
  }
  try {
    const detached = readDetachedPostMergeVerificationCohorts({ requireComplete: true });
    const denominator = readCurrentDetachedPostMergeDenominator();
    const denominatorProjection = projectDetachedPostMergeDenominator(
      denominator,
      detached,
      detachedTickets,
    );
    status.detachedPostMergeVerificationSource = {
      sourceState: detached.sourceState,
      sourcePresent: detached.sourcePresent,
      complete: detached.complete,
      stopReasons: detached.stopReasons,
      filesRead: detached.filesRead,
      bytesRead: detached.bytesRead,
      rowsScanned: detached.filesRead,
      invalidRows: detached.invalidFiles,
      unreadableFiles: detached.stopReasons.includes('io-error') ? 1 : 0,
    };
    status.detachedPostMergeDenominatorSource = {
      sourceState: denominator.sourceState,
      sourcePresent: denominator.sourcePresent,
      complete: denominator.complete,
      stopReasons: denominator.stopReasons,
      filesRead: denominator.filesRead,
      bytesRead: denominator.bytesRead,
      rowsScanned: denominator.receipt ? 1 : 0,
      invalidRows: denominator.invalidFiles,
      unreadableFiles: denominator.stopReasons.some((reason) =>
        ['io-error', 'unsafe-file', 'unsafe-path'].includes(reason)) ? 1 : 0,
    };
    const state: FleetDetachedPostMergeVerificationReadiness['state'] =
      denominator.sourceState === 'missing'
        ? 'missing'
        : denominator.sourceState === 'degraded' || !denominator.complete ||
            detached.sourceState === 'degraded' || !detached.complete
          ? 'degraded'
          : denominatorProjection.eligibleCandidates === 0
            ? 'conclusive'
            : denominatorProjection.observedCandidates === 0
            ? 'awaiting-observations'
            : denominatorProjection.observedCandidates !== denominatorProjection.eligibleCandidates ||
                denominatorProjection.conclusiveCandidates !== denominatorProjection.eligibleCandidates
              ? 'incomplete'
              : 'conclusive';
    status.detachedPostMergeVerificationReadiness = {
      version: 1,
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      state,
      latestObservedAt: denominatorProjection.latestObservedAt,
      passRate: denominatorProjection.passRate,
      denominator: {
        candidateSetDigest: denominator.receipt?.candidateSetDigest ?? null,
        eligibleCandidates: denominatorProjection.eligibleCandidates,
        observedCandidates: denominatorProjection.observedCandidates,
        conclusiveCandidates: denominatorProjection.conclusiveCandidates,
        unobservedCandidates: denominatorProjection.unobservedCandidates,
        pass: denominatorProjection.pass,
        fail: denominatorProjection.fail,
        unknown: denominatorProjection.unknown,
        queuedCandidates: denominatorProjection.queuedCandidates,
      },
      summary: detached.summary,
    };
  } catch {
    status.detachedPostMergeVerificationSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
    status.detachedPostMergeDenominatorSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
    status.detachedPostMergeVerificationReadiness = {
      version: 1,
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      state: 'degraded',
      latestObservedAt: null,
      passRate: null,
      denominator: {
        candidateSetDigest: null,
        eligibleCandidates: 0,
        observedCandidates: 0,
        conclusiveCandidates: 0,
        unobservedCandidates: 0,
        pass: 0,
        fail: 0,
        unknown: 0,
        queuedCandidates: 0,
      },
      summary: {
        cohorts: 0,
        denominatorCompleteCohorts: 0,
        conclusiveCompleteCohorts: 0,
        expectedMembers: 0,
        observedMembers: 0,
        pass: 0,
        fail: 0,
        unknown: 0,
      },
    };
  }
  let workedLearningRead: WorkedLedgerReadResult;
  try {
    workedLearningRead = loadWorkedLedgerDetailed();
  } catch {
    workedLearningRead = {
      ledger: { events: [] },
      sourceQuality: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        reasons: ['unstable-read'], bytesRead: 0,
      },
    };
  }
  let workspaceRead: AgentWorkspaceReadResult | undefined;
  try {
    workspaceRead = readAgentWorkspaceDetailed({
      windowMs: RECENT_WINDOW_MS,
      limit: 5000,
      limitPerDimension: 8,
      recentLimit: 8,
    });
    status.workspace = workspaceRead.workspace;
  } catch {
    // Optional history/analytics surface only.
  }
  const learningCutoffMs = Date.parse(generatedAt) - LEARNING_SNAPSHOT_SETTLE_MS;
  let learningProposals = settledLearningRows(
    allProposals,
    learningCutoffMs,
    (proposal) => learningSnapshotTimestamp(proposal.createdAt, proposal.decidedAt),
  );
  let learningDispatchEvents = settledLearningRows(
    dispatchLearningEvents ?? [],
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningActions = settledLearningRows(
    workspaceRead?.events ?? [],
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningDecisions = settledLearningRows(
    learningDecisionsRead?.decisions ?? [],
    learningCutoffMs,
    (decision) => decision.ts,
  );
  let learningJudgeTraces = settledLearningRows(
    learningJudgeTracesRead?.traces ?? [],
    learningCutoffMs,
    (trace) => learningSnapshotTimestamp(trace.ts, trace.outcomeAt),
  );
  let learningEvidencePacks = settledLearningRows(
    learningEvidenceRead?.packs ?? [],
    learningCutoffMs,
    (pack) => pack.generatedAt,
  );
  let learningWorkedEvents = settledLearningRows(
    workedLearningRead.ledger.events,
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningPostMergeObservations = settledLearningRows(
    learningPostMergeRead?.observations ?? [],
    learningCutoffMs,
    (observation) => observation.observedAt,
  );
  if (status.learningMetrics) {
    const rawLearningRows =
      allProposals.length +
      (dispatchLearningEvents?.length ?? 0) +
      (workspaceRead?.events.length ?? 0) +
      (learningDecisionsRead?.decisions.length ?? 0) +
      (learningJudgeTracesRead?.traces.length ?? 0) +
      (learningEvidenceRead?.packs.length ?? 0) +
      workedLearningRead.ledger.events.length +
      (learningPostMergeRead?.observations.length ?? 0);
    const settledLearningRowCount =
      learningProposals.length +
      learningDispatchEvents.length +
      learningActions.length +
      learningDecisions.length +
      learningJudgeTraces.length +
      learningEvidencePacks.length +
      learningWorkedEvents.length +
      learningPostMergeObservations.length;
    status.learningMetrics = {
      ...status.learningMetrics,
      settledThrough: new Date(learningCutoffMs).toISOString(),
      excludedRows: Math.max(0, rawLearningRows - settledLearningRowCount),
    };
    if ((dispatchLearningEvents?.length ?? 0) > 0 && learningDispatchEvents.length === 0) {
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-settling',
      };
    }
  }
  if (status.learningMetrics?.state === 'available') {
    try {
      const { listProposalsDetailed } = await import('../inbox/store.js');
      const proposalReadAfter = listProposalsDetailed();
      const dispatchReadAfter = readDispatchProductionYieldDetailed({
        windowMs: RECENT_WINDOW_MS,
        limit: 1200,
        limitPerDimension: 8,
      });
      const actionReadAfter = readAgentWorkspaceDetailed({
        windowMs: RECENT_WINDOW_MS,
        limit: 5000,
        limitPerDimension: 8,
        recentLimit: 8,
      });
      const decisionReadAfter = readDecisionsDetailed();
      const judgeTraceReadAfter = readJudgeTracesDetailed();
      const evidenceReadAfter = (await import('../autonomy/evidence-pack.js'))
        .readAutonomyEvidencePacksDetailed(Number.MAX_SAFE_INTEGER);
      const workedReadAfter = loadWorkedLedgerDetailed();
      const postMergeReadAfter = readPostMergeObservations({ requireComplete: true });

      const proposalRowsAfter = settledLearningRows(
        proposalReadAfter.proposals,
        learningCutoffMs,
        (proposal) => learningSnapshotTimestamp(proposal.createdAt, proposal.decidedAt),
      );
      const dispatchRowsAfter = settledLearningRows(
        dispatchReadAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const actionRowsAfter = settledLearningRows(
        actionReadAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const decisionRowsAfter = settledLearningRows(
        decisionReadAfter.decisions,
        learningCutoffMs,
        (decision) => decision.ts,
      );
      const judgeTraceRowsAfter = settledLearningRows(
        judgeTraceReadAfter.traces,
        learningCutoffMs,
        (trace) => learningSnapshotTimestamp(trace.ts, trace.outcomeAt),
      );
      const evidenceRowsAfter = settledLearningRows(
        evidenceReadAfter.packs,
        learningCutoffMs,
        (pack) => pack.generatedAt,
      );
      const workedRowsAfter = settledLearningRows(
        workedReadAfter.ledger.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const postMergeRowsAfter = settledLearningRows(
        postMergeReadAfter.observations,
        learningCutoffMs,
        (observation) => observation.observedAt,
      );

      const dispatchSnapshotStable = initialDispatchRead !== undefined &&
        learningSnapshotDigest(
          learningSnapshotSourceQuality(initialDispatchRead.sourceQuality),
          initialDispatchRead.events,
        ) === learningSnapshotDigest(
          learningSnapshotSourceQuality(dispatchReadAfter.sourceQuality),
          dispatchReadAfter.events,
        );

      const stable = [
        learningSnapshotDigest(learningSnapshotSourceQuality(proposalSourceQuality), learningProposals) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(proposalReadAfter), proposalRowsAfter),
        dispatchSnapshotStable,
        learningSnapshotDigest(learningSnapshotSourceQuality(workspaceRead?.sourceQuality), learningActions) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(actionReadAfter.sourceQuality), actionRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningDecisionsRead), learningDecisions) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(decisionReadAfter), decisionRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningJudgeTracesRead), learningJudgeTraces) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(judgeTraceReadAfter), judgeTraceRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningEvidenceRead), learningEvidencePacks) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(evidenceReadAfter), evidenceRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(workedLearningRead.sourceQuality), learningWorkedEvents) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(workedReadAfter.sourceQuality), workedRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningPostMergeRead), learningPostMergeObservations) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(postMergeReadAfter), postMergeRowsAfter),
      ].every(Boolean);

      if (stable) {
        status.dispatchProductionSource = dispatchReadAfter.sourceQuality;
        const dispatchAvailabilitySource = learningSourceAvailability(
          'dispatch-production',
          dispatchReadAfter.sourceQuality,
        );
        status.learningMetrics = {
          ...status.learningMetrics,
          sourceQuality: dispatchReadAfter.sourceQuality,
          dispatchProduction: learningMetricAvailability(
            [dispatchAvailabilitySource],
            [],
            1,
          ),
        };
        if (dispatchReadAfter.summary) {
          status.dispatchProduction = dispatchReadAfter.summary;
          status.dispatchYieldDiagnostics = buildDispatchYieldDiagnostics(
            dispatchReadAfter.summary,
            cfg,
            backends,
          );
        } else {
          delete status.dispatchProduction;
          delete status.dispatchYieldDiagnostics;
        }
        status.proposalFunnel = buildProposalFunnelObservability({
          events: dispatchReadAfter.events,
          sourceQuality: dispatchReadAfter.sourceQuality,
          windowMs: RECENT_WINDOW_MS,
          eventLimit: 1200,
        });
        learningProposals = proposalRowsAfter;
        learningDispatchEvents = dispatchRowsAfter;
        learningActions = actionRowsAfter;
        learningDecisions = decisionRowsAfter;
        learningJudgeTraces = judgeTraceRowsAfter;
        learningEvidencePacks = evidenceRowsAfter;
        learningWorkedEvents = workedRowsAfter;
        learningPostMergeObservations = postMergeRowsAfter;
      } else {
        if (!dispatchSnapshotStable) {
          const invalidatingSource = invalidatedDispatchProductionSource(
            dispatchReadAfter.sourceQuality,
          );
          status.dispatchProductionSource = invalidatingSource;
          delete status.dispatchProduction;
          delete status.dispatchYieldDiagnostics;
          const dispatchAvailabilitySource = learningSourceAvailability(
            'dispatch-production',
            invalidatingSource,
          );
          status.learningMetrics = {
            ...status.learningMetrics,
            sourceQuality: invalidatingSource,
            dispatchProduction: learningMetricAvailability(
              [dispatchAvailabilitySource],
              ['dispatchProduction'],
              1,
            ),
          };
        }
        if (status.proposalFunnel) {
          status.proposalFunnel = withholdProposalFunnelForUnstableSnapshot(
            status.proposalFunnel,
            !dispatchSnapshotStable ? status.dispatchProductionSource : undefined,
          );
        }
        status.learningMetrics = {
          ...status.learningMetrics,
          state: 'withheld',
          reason: 'learning-snapshot-unstable',
        };
      }
    } catch {
      const invalidatingSource = invalidatedDispatchProductionSource(
        status.dispatchProductionSource,
        'io-error',
      );
      status.dispatchProductionSource = invalidatingSource;
      delete status.dispatchProduction;
      delete status.dispatchYieldDiagnostics;
      if (status.proposalFunnel) {
        status.proposalFunnel = withholdProposalFunnelForUnstableSnapshot(
          status.proposalFunnel,
          invalidatingSource,
        );
      }
      const dispatchAvailabilitySource = learningSourceAvailability(
        'dispatch-production',
        invalidatingSource,
      );
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-unstable',
        sourceQuality: invalidatingSource,
        dispatchProduction: learningMetricAvailability(
          [dispatchAvailabilitySource],
          ['dispatchProduction'],
          1,
        ),
      };
    }
  }
  const workspaceSource = status.workspace?.sourceQuality;
  if (workspaceSource) {
    Object.defineProperty(learningActions, 'sourceQuality', {
      value: workspaceSource,
      enumerable: false,
    });
  }
  const dispatchSource = learningSourceAvailability('dispatch-production', status.dispatchProductionSource);
  const actionSource = learningSourceAvailability('agent-actions', workspaceSource);
  const outcomeSource = learningSourceAvailability('outcomes', proposalSourceQuality);
  const decisionSource = learningSourceAvailability('decisions', status.decisionsSource);
  const evidenceSource = learningSourceAvailability('evidence', learningEvidenceRead);
  const workedSource = learningSourceAvailability('worked', workedLearningRead.sourceQuality);
  const postMergeSource = learningSourceAvailability('post-merge', learningPostMergeRead);
  const proposalById = new Map(learningProposals.map((proposal) => [proposal.id, proposal]));
  const evidencePacks = learningEvidencePacks;
  const evidenceByProposal = new Map(evidencePacks.map((pack) => [pack.proposal.id, pack]));
  const unavailablePostMerge: PostMergeObservationReadResult = {
    observations: [], sourceState: 'degraded', sourcePresent: true, complete: false,
    stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, physicalRows: 0,
    invalidRows: 0, conflictingEvents: 0, duplicateRows: 0, supersededRows: 0,
    limitExceeded: false,
  };
  let outcomeRecords: OutcomeRecord[] = [];
  if (status.learningMetrics?.state === 'available') {
    try {
      outcomeRecords = listOutcomeRecords({
        limit: 1000,
        deps: {
          listProposals: () => learningProposals,
          readDecisions: () => learningDecisions,
          readJudgeTraces: () => learningJudgeTraces,
          listAutonomyEvidencePacks: () => evidencePacks,
          loadWorkedLedger: () => ({ events: learningWorkedEvents }),
          readPostMergeObservations: () => learningPostMergeRead
            ? { ...learningPostMergeRead, observations: learningPostMergeObservations }
            : unavailablePostMerge,
        },
      });
      const attemptRecords = listAttemptRecords({
        windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
        limit: 500,
        deps: {
          readDispatchProductionEvents: () => learningDispatchEvents,
          readAgentActions: () => learningActions,
          listOutcomeRecords: () => outcomeRecords,
          loadProposal: (id) => proposalById.get(id) ?? null,
          readDecisions: () => learningDecisions,
          listAutonomyEvidencePacks: () => evidencePacks,
          readAutonomyEvidencePack: (id) => evidenceByProposal.get(id) ?? null,
          loadWorkedLedger: () => ({ events: learningWorkedEvents }),
        },
        useDefaultReaders: false,
      });
      const unavailable = new Set<keyof AttemptRecordCoverage>();
      if (!learningSourceAvailable(actionSource)) unavailable.add('agentAction');
      if (!learningSourceAvailable(outcomeSource)) unavailable.add('outcomeRecord');
      if (!learningSourceAvailable(decisionSource)) unavailable.add('decision');
      if (!learningSourceAvailable(evidenceSource)) unavailable.add('evidence');
      if (!learningSourceAvailable(workedSource)) unavailable.add('worked');
      status.attemptCoverage = withholdAttemptJoinMetrics(
        summarizeAttemptCoverage(attemptRecords, RECENT_WINDOW_MS / (60 * 60 * 1000)),
        unavailable,
      );
      if (workspaceSource) status.attemptCoverage.agentActionSource = workspaceSource;
      status.learningMetrics.attemptCoverage = learningMetricAvailability(
        [dispatchSource, actionSource, outcomeSource, decisionSource, evidenceSource, workedSource],
        [...unavailable].map((metric) => `coverage.${metric}`),
        6,
      );
    } catch {
      status.learningMetrics.attemptCoverage = learningMetricAvailability(
        [dispatchSource, { source: 'outcomes', sourceState: 'degraded', complete: false }],
        ['coverage.agentAction', 'coverage.outcomeRecord', 'coverage.decision', 'coverage.evidence', 'coverage.worked'],
        5,
      );
    }
  }
  const windowHours = RECENT_WINDOW_MS / (60 * 60 * 1000);
  const skillUseSource = readSkillUseEventsWithDiagnostics({
    sinceMs: Date.parse(generatedAt) - RECENT_WINDOW_MS,
    limit: Math.max(500 * 8, 400),
    maxFiles: 3,
  });
  let learningSkillUseEvents = settledLearningRows(
    skillUseSource.events,
    learningCutoffMs,
    (event) => event.ts,
  );
  if (status.learningMetrics) {
    status.learningMetrics.excludedRows =
      (status.learningMetrics.excludedRows ?? 0) +
      Math.max(0, skillUseSource.events.length - learningSkillUseEvents.length);
  }
  if (status.learningMetrics?.state === 'available') {
    try {
      const skillUseSourceAfter = readSkillUseEventsWithDiagnostics({
        sinceMs: Date.parse(generatedAt) - RECENT_WINDOW_MS,
        limit: Math.max(500 * 8, 400),
        maxFiles: 3,
      });
      const skillRowsAfter = settledLearningRows(
        skillUseSourceAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const skillQuality = {
        sourceState: skillUseSource.sourceState,
        sourcePresent: skillUseSource.sourcePresent,
        eventState: skillUseSource.eventState,
      };
      const skillQualityAfter = {
        sourceState: skillUseSourceAfter.sourceState,
        sourcePresent: skillUseSourceAfter.sourcePresent,
        eventState: skillUseSourceAfter.eventState,
      };
      if (learningSnapshotDigest(skillQuality, learningSkillUseEvents) ===
          learningSnapshotDigest(skillQualityAfter, skillRowsAfter)) {
        learningSkillUseEvents = skillRowsAfter;
      } else {
        status.learningMetrics = {
          ...status.learningMetrics,
          state: 'withheld',
          reason: 'learning-snapshot-unstable',
        };
        status.attemptCoverage = undefined;
      }
    } catch {
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-unstable',
      };
      status.attemptCoverage = undefined;
    }
  }
  const skillSource = learningSourceAvailability('skill-use', {
    sourceState: skillUseSource.sourceState,
    complete: skillUseSource.sourceState === 'healthy',
  });
  if (status.learningMetrics?.state === 'available') {
    try {
      const trajectoryRecords = listTrajectoryRecords({
        windowHours,
        limit: 500,
        deps: {
          readDispatchProductionEvents: () => learningDispatchEvents,
          readAgentActions: () => learningActions,
          readSkillUseEvents: () => learningSkillUseEvents,
          listOutcomeRecords: () => outcomeRecords,
          loadProposal: (id) => proposalById.get(id) ?? null,
        },
      });
      const unavailable = new Set<keyof TrajectoryRecordCoverage>();
      if (!learningSourceAvailable(outcomeSource)) unavailable.add('proposal');
      if (!learningSourceAvailable(evidenceSource)) unavailable.add('evidence');
      if (!learningSourceAvailable(decisionSource)) unavailable.add('decision');
      if (!learningSourceAvailable(actionSource)) unavailable.add('agentAction');
      if (!learningSourceAvailable(skillSource)) unavailable.add('skillUse');
      const terminalAvailable = learningSourceAvailable(outcomeSource) &&
        learningSourceAvailable(decisionSource);
      const realizedAvailable = terminalAvailable && learningSourceAvailable(postMergeSource);
      const tracesAvailable = terminalAvailable && learningSourceAvailable(evidenceSource) &&
        learningSourceAvailable(actionSource) && learningSourceAvailable(workedSource) &&
        learningSourceAvailable(postMergeSource);
      status.trajectoryLearning = withholdTrajectoryMetrics(
        summarizeTrajectoryLearning(trajectoryRecords, windowHours),
        unavailable,
        { terminal: terminalAvailable, realized: realizedAvailable, traces: tracesAvailable },
      );
      const withheldMetrics = [
        ...[...unavailable].map((metric) => `coverage.${metric}`),
        ...(!terminalAvailable ? ['terminalOutcomes', 'routeSpine.dispatchToMerge'] : []),
        ...(!realizedAvailable ? ['realizedOutcomes'] : []),
        ...(!learningSourceAvailable(decisionSource) ? ['routeSpine.dispatchToDecision'] : []),
        ...(!learningSourceAvailable(evidenceSource) ? ['routeSpine.dispatchToEvidence'] : []),
        ...(!tracesAvailable ? ['traces'] : []),
      ];
      status.learningMetrics.trajectoryLearning = learningMetricAvailability(
        [
          dispatchSource, actionSource, outcomeSource, decisionSource, evidenceSource,
          workedSource, postMergeSource, skillSource,
        ],
        withheldMetrics,
        12,
      );
    } catch {
      status.learningMetrics.trajectoryLearning = learningMetricAvailability(
        [dispatchSource, { source: 'outcomes', sourceState: 'degraded', complete: false }],
        [
          'terminalOutcomes', 'realizedOutcomes', 'coverage.proposal', 'coverage.evidence',
          'coverage.decision', 'coverage.agentAction', 'coverage.skillUse', 'routeSpine', 'traces', 'recent',
        ],
        10,
      );
    }
  }
  if (status.trajectoryLearning && !learningSourceAvailable(skillSource)) {
    status.trajectoryLearning = suppressDegradedSkillObservation(
      status.trajectoryLearning,
      skillUseSource.events.length > 0 ? 'present' : 'none',
    );
  }
  if (status.learningMetrics?.state === 'withheld') {
    status.learningMetrics.attemptCoverage = learningMetricAvailability(
      [dispatchSource],
      ['production', 'coverage.agentAction', 'coverage.outcomeRecord', 'coverage.decision', 'coverage.evidence', 'coverage.worked'],
      6,
    );
    status.learningMetrics.trajectoryLearning = learningMetricAvailability(
      [dispatchSource],
      [
        'trajectories', 'terminalOutcomes', 'realizedOutcomes', 'coverage.dispatch',
        'coverage.proposal', 'coverage.evidence', 'coverage.decision', 'coverage.agentAction',
        'coverage.skillUse', 'routeSpine', 'traces', 'recent',
      ],
      12,
    );
  }
  status.skillCorpusReadiness = await readSkillCorpusReadiness(
    status.trajectoryLearning?.skillObservation,
    skillUseSource.eventState,
  );
  const contextInput = status.workspace?.sourceQuality &&
    (status.workspace.sourceQuality.sourceState !== 'healthy' || !status.workspace.sourceQuality.complete)
    ? { ...status, workspace: undefined }
    : status;
  try {
    const { genomeHubHealth } = await import('../genome/store.js');
    status.contextEfficiency = buildContextEfficiencyStatus(contextInput, genomeHubHealth(), generatedAt, RECENT_WINDOW_MS);
  } catch {
    status.contextEfficiency = buildContextEfficiencyStatus(contextInput, undefined, generatedAt, RECENT_WINDOW_MS);
  }

  try {
    const { buildResourceStrategyReport } = await import('../autonomy/resource-strategy.js');
    const report = await buildResourceStrategyReport(cfg, {
      maxOutcomes: 3,
      maxChecks: 3,
      deps: {
        buildFleetStatus: async () => status,
        getResourceSnapshot: async () => {
          if (backends.length === 0) return { generatedAt: new Date().toISOString(), backends: [] };
          const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
          // Keep this later observation fresh under the monitor's existing cache.
          return getResourceSnapshot(resourceConfig);
        },
        runEcosystemDoctor: async (opts) => lightweightEcosystemReport(opts?.now, opts?.root),
        ...(guardHealth !== undefined ? { diagnoseGuardHealth: () => guardHealth } : {}),
      },
    });
    status.autonomyDirection = buildAutonomyDirectionSummary(report);
  } catch {
    // Optional advisory surface only. Fleet status remains available if any
    // strategy signal source is unavailable.
  }

  status.autonomyEffectiveness = buildAutonomyEffectiveness(status);
  status.nextActions = buildNextActions(status);
  status.autonomousShipReadiness = buildAutonomousShipReadiness(status, {
    generatedAt,
    queueSnapshotAt: queueAuthorityObservedAt,
    queueSourceStatus,
    queueSourceDetail,
  });
  status.missionBrief = buildMissionBrief(status);

  // Construct this forensic projection only after every operational and
  // authority-bearing status has been derived.
  status.cutoffCheckpoints = readFleetCutoffCheckpointStatus(generatedAt);
  try {
    const { automergeCanaryStatus } = await import('./automerge-canary-store.js');
    const canaryRead = automergeCanaryStatus();
    status.autoMergeCanary = projectAutoMergeCanaryStatus(canaryRead);
    status.autoMergeCanaryPromotionReadiness = buildAutoMergeCanaryPromotionReadiness(
      status,
      cfg,
      canaryRead,
      Date.parse(generatedAt),
    );
  } catch {
    status.autoMergeCanary = degradedAutoMergeCanaryStatus();
    status.autoMergeCanaryPromotionReadiness = evaluateAutoMergeCanaryPromotionReadiness({
      observedAtMs: Date.parse(generatedAt),
      canary: {
        sourceState: 'degraded', active: false, state: 'critical',
        observationCompletedAt: null, attempts: 0, eligible: 0, rejected: 0,
        requiredAttempts: 1, requiredEligible: 1, requirementsBound: false,
        bindingMismatches: 0, inspectionErrors: 1,
      },
      remoteProtection: {
        configured: 'missing', live: 'unavailable', coverage: 'none', observedAt: null,
      },
      verification: {
        sourceState: 'degraded', enrolledRepos: 0, mergeGradeRepos: 0, noCommandRepos: 0,
      },
      evidenceSigning: {
        sourceState: 'missing', signed: false, writable: false, expiresAt: null,
      },
      release: {
        sourceState: 'missing', signatureVerified: false, manifestComplete: false,
        artifactBound: false, serviceInvocationBound: false, configurationBound: false,
        expiresAt: null, rollbackBound: false,
      },
      postMerge: {
        sourceState: 'degraded', complete: false, denominatorComplete: false,
        releasedCohorts: 0, adverseObservations: 0, latestCompletedAt: null,
      },
      policy: {
        allowSelfMerge: true, allowWithoutVerification: true, localMergeFallback: true,
        maxAutomergeFiles: null, maxAutomergeLines: null,
      },
      scopeIdentity: {
        sourceState: 'degraded',
        expectedPolicyDigest: null, expectedConfigDigest: null,
        evidencePolicyDigest: null, evidenceConfigDigest: null,
        currentPolicyDigest: null, currentConfigDigest: null,
        currentScopePolicyDigest: null, observedAt: null,
      },
    });
  }

  return status;
}

export type {
  FleetBackendResourceStatus,
  FleetBackendStatus,
  FleetGoalFocusStatus,
  FleetSharedQueueStatus,
  FleetPhantomState,
  FleetPhantomStatus,
  FleetAutonomyEvidenceSummary,
  FleetAutonomyStatus,
  FleetAutonomyDirectionSummary,
  FleetAutonomyControlMode,
  FleetAutoMergeBlockerSummary,
  FleetAutoMergeVerifierContractGap,
  FleetAutoMergeVerifierContractStatus,
  FleetAutoMergeReadinessStatus,
  FleetProposalSourceQuality,
  FleetProposalAuthoritySource,
  FleetNextActionCommandSafety,
  FleetNextActionCommand,
  FleetNextAction,
  FleetAutonomyEffectivenessPhase,
  FleetAutonomyEffectivenessStatus,
  FleetAutonomousShipReadinessVerdict,
  FleetAutonomousShipReadinessConfidence,
  FleetReadinessSourceStatus,
  FleetReadinessFreshness,
  FleetReadinessSourceQualityBadge,
  FleetReadinessSourceCategory,
  FleetReadinessEvidenceEligibility,
  FleetReadinessEvidenceRole,
  FleetReadinessEvidenceApplicability,
  FleetReadinessEvidenceQuality,
  FleetDetachedPostMergeVerificationReadiness,
  FleetPostMergeCompositeProjection,
  FleetReadinessSourceQuality,
  FleetSkillCorpusReadiness,
  FleetSkillCorpusReadinessInput,
  FleetReadinessSourceHealth,
  FleetAutonomousShipReadinessBlocker,
  FleetAutonomousShipReadinessStatus,
  FleetMissionBriefEvidence,
  FleetMissionBrief,
  FleetProposalProductionReasonSummary,
  FleetProposalProductionDispatchSummary,
  FleetProposalProductionStatus,
  FleetDispatchYieldDiagnosticVerdict,
  FleetDispatchYieldDiagnosticAction,
  FleetDispatchYieldDiagnosticCandidate,
  FleetDispatchYieldDiagnostics,
  FleetDispatchManifestRecent,
  FleetDispatchManifestStatus,
  FleetQueueNextItem,
  FleetQueueInventorySourceStatus,
  FleetQueueGeneratedWorkStatus,
  FleetGeneratedRepairRouteStatus,
  FleetQueueScannerEvidenceStatus,
  FleetResolutionObserverStatus,
  FleetActiveWorkStatus,
  FleetDiagnosticResliceDrainStatus,
  FleetRepairHandoffRolloutStatus,
  FleetQueueRepoCoverage,
  FleetAutoMergeCanaryTelemetry,
  FleetAutoMergeCanaryStatus,
  FleetLearningSourceName,
  FleetLearningWithholdingReason,
  FleetLearningSourceAvailability,
  FleetLearningMetricAvailability,
  FleetStatus,
  FleetDaemonStatusRead,
} from './status-types.js';

export {
  projectAutoMergeCanaryStatus,
  buildAutoMergeCanaryPromotionReadiness,
} from './status-automerge.js';

export {
  buildSkillCorpusReadiness,
  projectPostMergeComposite,
} from './status-learning.js';

export {
  buildRepairHandoffRolloutStatus,
  repairHandoffProjectionTick,
} from './status-queue.js';

export {
  resolveAutonomyControlMode,
  readFleetDaemonStatus,
} from './status-sources.js';
