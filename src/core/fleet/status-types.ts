/** Fleet status: types. Internal to status.ts. */

import type { PoolBudgetSnapshot } from './pool-budget.js';
import type {
  BackendAvailability,
  BackendResourceState,
} from '../fabric/resource-monitor.js';
import type {
  EngineId,
  PhantomAgentReportRollup,
  AutoMergeTrustBasis,
  WorkItem,
  DaemonTick,
} from '../types.js';
import type {
  SharedQueueHealth,
} from './shared-store.js';
import type {
  AutonomyEvidencePack,
  AutonomyEvidenceSourceQuality,
} from '../autonomy/evidence-pack.js';
import type {
  ResourceStrategyReport,
} from '../autonomy/resource-strategy.js';
import type {
  DetachedPostMergeVerificationSummary,
} from './detached-post-merge-verification.js';
import type {
  TrajectoryLearningStatus,
} from '../autonomy/trajectory-records.js';
import type {
  DispatchProductionYieldSummary,
  DispatchProductionSourceQuality,
} from './dispatch-production-ledger.js';
import type {
  GeneratedRepairRouteReason,
} from './router.js';
import type {
  ResolutionObserverStatus,
} from './resolution-observer.js';
import type {
  RepairHandoffV2Activation,
} from './repair-handoff-journal.js';
import type {
  RepoProjectKind,
  RepoPackageManager,
} from '../run/repo-profile.js';
import type {
  StrategicTier,
} from '../ecosystem/focus.js';
import type {
  AutoMergeCanaryShadowCountersV1,
  AutoMergeCanaryShadowEvidenceV1,
  AutoMergeCanaryReadResult,
  AutoMergeCanaryBudgetsV1,
  AutoMergeCanaryCountersV1,
  AutoMergeCanaryBlockerV1,
} from './automerge-canary-store.js';
import type {
  BuildIdentity,
} from '../build-identity.js';
import type {
  DaemonActivationReadiness,
} from '../daemon/activation-permit.js';
import type {
  AutoMergeCanaryPromotionReadiness,
} from './automerge-canary-promotion-readiness.js';
import type {
  GuardHealthDiagnosis,
} from '../daemon/guard-health.js';
import type {
  FleetLaneLocksStatus,
} from './lane-lock.js';
import type {
  ProposalFunnelObservability,
} from './proposal-funnel-observability.js';
import type {
  RoutingLearningAuthority,
} from '../run/learned-router.js';
import type {
  DecisionSourceQuality,
} from './decisions-ledger.js';
import type {
  JudgeTraceSourceQuality,
} from './judge-trace.js';
import type {
  DispatchManifestSourceQuality,
} from './dispatch-manifest.js';
import type {
  BestOfNSourceQuality,
} from './best-of-n-ledger.js';
import type {
  PostMergeStabilityCohortSummary,
} from './post-merge-stability.js';
import type {
  FleetCutoffCheckpointStatus,
} from './cutoff-observation-status.js';
import type {
  AgentWorkspaceStatus,
} from './agent-action-ledger.js';
import type {
  AttemptCoverageStatus,
} from '../autonomy/attempt-records.js';
import type {
  FleetContextEfficiencyStatus,
} from './context-efficiency.js';

export interface FleetBackendResourceStatus {
  availability: BackendAvailability | 'not-sensed';
  usedPct: number | null;
  cap: number | null;
  capUnit: BackendResourceState['capUnit'];
  capWindow: string | null;
  resetsAt: number | null;
  reason: string;
  snapshotAt: string | null;
}

/** A single backend's recent activity + quota standing. */
export interface FleetBackendStatus {
  /** The backend id (e.g. 'builtin', 'claude', 'codex'). */
  backend: EngineId;
  /** Dispatches recorded for this backend in the recent window (last 24h). */
  dispatchesRecent: number;
  /** Quota standing: 'unlimited' when no rate limit is configured. */
  quota: 'ok' | 'warn' | 'over' | 'unlimited';
  /** Resource availability for the allowed backend, when sensed or explicitly unsensed. */
  resource?: FleetBackendResourceStatus;
}

export interface FleetGoalFocusStatus {
  enabled: boolean;
  activeThreshold: number;
  activeGoalCount: number;
  actionableActiveGoalCount: number;
  planningGoalCount: number;
  deferredNewGoalWork: boolean;
  reason: 'disabled' | 'below-threshold' | 'active-goal-work-in-flight';
  visibleGoalBacklogItems: number;
  visibleInventBacklogItems: number;
}

/** Shared filesystem queue health, when multi-machine queueing is enabled. */
export interface FleetSharedQueueStatus extends SharedQueueHealth {
  enabled: boolean;
  mode: 'filesystem';
  machineId: string;
  trustedCoherentStorage: boolean;
  authorityReady: boolean;
}

export type FleetPhantomState = 'ready' | 'not-installed' | 'not-initialized' | 'degraded';

export interface FleetPhantomStatus {
  observedAt: string;
  state: FleetPhantomState;
  installed: boolean;
  initialized: boolean;
  version: string | null;
  valueMode: 'metadata-and-names-only';
  secretCount: number;
  knownFleetSecrets: {
    total: number;
    presentCount: number;
    missingCount: number;
    pulseCredentialPresent: boolean;
    nimApiKeyPresent: boolean;
  };
  capabilities: {
    metadataStatus: boolean;
    childEnvInjectionAvailable: boolean;
    mcpServerAvailable: boolean;
    mutationRequiresHumanApproval: boolean;
  };
  commands: {
    commandsKnown: boolean;
    setupAvailable: boolean;
    execAvailable: boolean;
    mcpAvailable: boolean;
    agentAvailable: boolean;
  };
  agentReport?: PhantomAgentReportRollup;
  config: {
    phantomExecEnabled: boolean;
    fleetSecretInjectionEnabled: boolean;
  };
  mcp: {
    configured: boolean;
  };
  error?: string;
}

export interface FleetAutonomyEvidenceSummary {
  proposalId: string;
  generatedAt: string;
  title: string;
  tier: string | null;
  action: string | null;
  allowed: boolean | null;
  target: AutonomyEvidencePack['target'];
  riskClass: AutonomyEvidencePack['riskClass'];
  verificationPassed: boolean;
  changedFiles: number;
  changedLines: number;
  reason: string | null;
}

export interface FleetAutonomyStatus {
  evidencePacks: number;
  latestAt: string | null;
  allowed: number;
  denied: number;
  byTier: Record<string, number>;
  recent: FleetAutonomyEvidenceSummary[];
  /** Fail-closed health of the signed evidence authority store. */
  authorityState: 'ready' | 'cold-start' | 'degraded';
  protocols: {
    sealedV3: number;
    legacy: number;
  };
  sourceQuality: AutonomyEvidenceSourceQuality;
}

export interface FleetAutonomyDirectionSummary {
  generatedAt: string;
  mode: ResourceStrategyReport['mode'];
  confidence: ResourceStrategyReport['confidence'];
  reasons: string[];
  recommendedActions: string[];
  resources: Pick<ResourceStrategyReport['resources'], 'posture' | 'constrained' | 'depleted'>;
  guardHealth: {
    blocked: boolean;
    blocks: number;
  };
  budgets: Pick<ResourceStrategyReport['budgets'], 'daemonBudgetLevel' | 'daemonSpentTodayUsd'>;
  productionVelocity: Pick<
    ResourceStrategyReport['productionVelocity'],
    'enabled' | 'profile' | 'fillQueueToSlots' | 'stalePendingTtlHours' | 'maxSlotsPerBackend' | 'caps' | 'flags'
  >;
}

export type FleetAutonomyControlMode = 'disabled' | 'advisory' | 'executable';

export interface FleetAutoMergeBlockerSummary {
  proposalId: string;
  title: string;
  tier: string | null;
  reason: string;
  riskClass: string | null;
}

export interface FleetAutoMergeVerifierContractGap {
  proposalId: string;
  title: string;
  repo: string;
  name: string;
  withoutVerifyCommands: boolean;
  withoutExplicitMergeContract: boolean;
  reason: string;
}

export interface FleetAutoMergeVerifierContractStatus {
  pendingNeedingVerification: number;
  withoutVerifyCommands: number;
  withoutExplicitMergeContract: number;
  recentGaps: FleetAutoMergeVerifierContractGap[];
}

export interface FleetAutoMergeReadinessStatus {
  enabled: boolean;
  trustBasis: AutoMergeTrustBasis;
  pending: number;
  /** Cheap static candidates; this is observational and does not imply merge authority. */
  preflightReady: number;
  /** Candidates whose currently persisted evidence clears the read-only authority gate. */
  authorityReady?: number;
  /** Authority-ready branch-only candidates, which do not depend on protected-main state. */
  branchAuthorityReady?: number;
  /** Main-target candidates before protected-remote status is applied. */
  remoteMainAuthorityReady?: number;
  /** Cheap candidates withheld because authority evidence is absent or untrustworthy. */
  authorityBlocked?: number;
  authorityByReason?: Record<string, number>;
  needsVerification: number;
  knownVerificationFailed: number;
  blocked: number;
  byReason: Record<string, number>;
  recentBlockers: FleetAutoMergeBlockerSummary[];
  verifierContracts?: FleetAutoMergeVerifierContractStatus;
  configurationBlocker?: string;
  remoteProtection?: {
    required: boolean;
    configured: 'exact' | 'legacy' | 'invalid' | 'missing';
    live: 'protected' | 'unprotected' | 'unavailable' | 'unobserved';
    coverage: 'complete' | 'partial' | 'unscoped';
    observedAt: string | null;
    reposObserved: number;
    reposRequired: number;
    detail: string;
  };
}

export interface FleetProposalSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: string[];
  filesDiscovered: number;
  filesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
}

export interface FleetProposalAuthoritySource {
  gate: 'ready' | 'unavailable';
  detail: string;
}

export type FleetNextActionCommandSafety =
  | 'read-only'
  | 'control-plane'
  | 'autonomous-dispatch'
  | 'manual';

export interface FleetNextActionCommand {
  label: string;
  argv: string[];
  shell: string;
  safety: FleetNextActionCommandSafety;
  cwd?: string;
  endpointMethod?: 'GET' | 'POST';
  endpointPath?: string;
  tokenRequired?: boolean;
  note?: string;
}

export interface FleetNextAction {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  label: string;
  detail: string;
  target?: string;
  commands?: FleetNextActionCommand[];
}

export type FleetAutonomyEffectivenessPhase =
  | 'control-blocked'
  | 'host-handoff'
  | 'merge-ready'
  | 'verification-needed'
  | 'merge-blocked'
  | 'proposal-starved'
  | 'route-gated'
  | 'cooldown-gated'
  | 'idle';

export interface FleetAutonomyEffectivenessStatus {
  phase: FleetAutonomyEffectivenessPhase;
  canAutoMergeNow: boolean;
  bottleneck:
    | 'control'
    | 'host-handoff'
    | 'merge-drain'
    | 'verification'
    | 'merge-gate'
    | 'proposal-production'
    | 'routing'
    | 'cooldown'
    | 'none';
  summary: string;
  counts: {
    backlogItems: number;
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    repairRouteBlockedItems?: number;
    nextEligibleAt?: string | null;
    pendingProposals: number;
    frontierPending: number;
    awaitingHostMerge: number;
    preflightReady: number;
    authorityReady?: number;
    needsVerification: number;
    blocked: number;
    knownVerificationFailed: number;
    recentMerges: number;
  };
}

export type FleetAutonomousShipReadinessVerdict = 'ready' | 'blocked' | 'degraded' | 'idle' | 'unknown';

export type FleetAutonomousShipReadinessConfidence = 'high' | 'medium' | 'low';

export type FleetReadinessSourceStatus = 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';

export type FleetReadinessFreshness = 'fresh' | 'stale' | 'unknown' | 'not-applicable';

export type FleetReadinessSourceQualityBadge =
  | 'healthy-source'
  | 'healthy-zero'
  | 'degraded-source'
  | 'missing-source'
  | 'stale-source'
  | 'unknown-source';

export type FleetReadinessSourceCategory = 'operations' | 'evidence';

export type FleetReadinessEvidenceEligibility =
  | 'eligible' | 'cold-start' | 'withheld' | 'observational' | 'not-applicable';

export type FleetReadinessEvidenceRole =
  | 'merge-authority' | 'merge-gate' | 'learning' | 'analytics' | 'forensics';

export type FleetReadinessEvidenceApplicability = 'required' | 'optional' | 'disabled';

export interface FleetReadinessEvidenceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: readonly string[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface FleetDetachedPostMergeVerificationReadiness {
  version: 1;
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  state: 'missing' | 'degraded' | 'awaiting-observations' | 'incomplete' | 'conclusive';
  latestObservedAt: string | null;
  passRate: number | null;
  denominator: {
    candidateSetDigest: string | null;
    eligibleCandidates: number;
    observedCandidates: number;
    conclusiveCandidates: number;
    unobservedCandidates: number;
    pass: number;
    fail: number;
    unknown: number;
    queuedCandidates: number;
  };
  summary: DetachedPostMergeVerificationSummary;
}

export interface FleetPostMergeCompositeProjection {
  source: FleetReadinessEvidenceQuality;
  cohort?: NonNullable<FleetStatus['postMergeCohort']>;
}

export interface FleetReadinessSourceQuality {
  badge: FleetReadinessSourceQualityBadge;
  label: string;
  empty: boolean;
  sourcePresent: boolean;
  detail: string;
}

export interface FleetSkillCorpusReadiness {
  version: 1;
  mode: 'shadow';
  policyVersion: string;
  corpus: {
    state: 'no-cards' | 'degraded' | 'ready';
    sourceQuality: FleetReadinessSourceQuality;
  };
  eligibleSignedCards: 'none' | 'available';
  selectedObservations: 'none' | 'present' | 'degraded';
  learning: {
    state:
      | 'blocked-no-cards'
      | 'blocked-corpus-degraded'
      | 'blocked-observation-degraded'
      | 'awaiting-eligible-cards'
      | 'awaiting-selection'
      | 'k-gated'
      | 'observable';
    minimumObservedTrajectories: number;
    sampleState: 'none' | 'unavailable' | 'insufficient-sample' | 'observed';
    observedTrajectoryCoverage?: { count: number; rate: number };
  };
}

export interface FleetSkillCorpusReadinessInput {
  corpusState: FleetSkillCorpusReadiness['corpus']['state'];
  corpusSourceQuality: FleetReadinessSourceQuality;
  eligibleSignedCards: FleetSkillCorpusReadiness['eligibleSignedCards'];
  skillObservation?: TrajectoryLearningStatus['skillObservation'];
  observationState?: 'none' | 'present' | 'degraded';
  policyVersion?: string;
}

export interface FleetReadinessSourceHealth {
  id:
    | 'daemon' | 'guard' | 'auto-merge' | 'queue' | 'lane-locks' | 'resources' | 'direction' | 'phantom'
    | 'decisions' | 'judge-traces' | 'agent-actions' | 'dispatch-production'
    | 'dispatch-manifests' | 'best-of-n' | 'post-merge' | 'autonomy-packs';
  label: string;
  status: FleetReadinessSourceStatus;
  badge: 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';
  freshness: FleetReadinessFreshness;
  observedAt: string | null;
  ageMs: number | null;
  detail: string;
  sourceQuality?: FleetReadinessSourceQuality;
  category?: FleetReadinessSourceCategory;
  evidenceRole?: FleetReadinessEvidenceRole;
  eligibility?: FleetReadinessEvidenceEligibility;
  applicability?: FleetReadinessEvidenceApplicability;
  actionSynthesis?: 'eligible' | 'observational-only';
  evidenceQuality?: FleetReadinessEvidenceQuality;
}

export interface FleetAutonomousShipReadinessBlocker {
  id: string;
  label: string;
  detail: string;
  severity: FleetNextAction['priority'];
  source: FleetReadinessSourceHealth['id'] | 'fleet';
}

export interface FleetAutonomousShipReadinessStatus {
  verdict: FleetAutonomousShipReadinessVerdict;
  confidence: FleetAutonomousShipReadinessConfidence;
  freshness: {
    generatedAt: string;
    overall: Exclude<FleetReadinessFreshness, 'not-applicable'>;
    freshestAt: string | null;
    stalestAt: string | null;
    maxAgeMs: number | null;
    staleSources: number;
    unknownSources: number;
  };
  topBlocker: FleetAutonomousShipReadinessBlocker | null;
  primaryAction: FleetNextAction | null;
  sources: FleetReadinessSourceHealth[];
  sourceSummary: Record<FleetReadinessSourceStatus, number>;
  sourceQualitySummary?: Record<FleetReadinessSourceQualityBadge, number>;
  evidenceMatrix?: {
    version: 1;
    state: 'eligible' | 'cold-start' | 'degraded';
    sources: FleetReadinessSourceHealth[];
    summary: Record<FleetReadinessEvidenceEligibility, number>;
  };
}

export interface FleetMissionBriefEvidence {
  readinessVerdict: FleetAutonomousShipReadinessVerdict | null;
  effectivenessPhase: FleetAutonomyEffectivenessPhase | null;
  bottleneck: FleetAutonomyEffectivenessStatus['bottleneck'] | null;
  queueBacklogItems: number;
  eligibleBacklogItems: number;
  pendingProposals: number;
  preflightReady: number;
  guardBlocked: boolean;
}

export interface FleetMissionBrief {
  generatedAt: string;
  directive: string;
  confidence: FleetAutonomousShipReadinessConfidence;
  operatingMode: string;
  blocker: FleetAutonomousShipReadinessBlocker | null;
  action: FleetNextAction | null;
  whyNow: string;
  evidence: FleetMissionBriefEvidence;
}

export interface FleetProposalProductionReasonSummary {
  reason: string;
  count: number;
}

export interface FleetProposalProductionDispatchSummary {
  ts: string;
  itemId: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  backend: EngineId | null;
  productionOutcome?: string;
  reason: string;
}

export interface FleetProposalProductionStatus {
  windowHours: number;
  selected: number;
  claimed: number;
  dispatched: number;
  skipped: number;
  errors: number;
  proposalsCreated: number;
  noProposalDispatches: number;
  suppressedDispatches: number;
  diagnosticNoProposalDispatches: number;
  topReasons: FleetProposalProductionReasonSummary[];
  diagnosticTopReasons: FleetProposalProductionReasonSummary[];
  skipReasons: FleetProposalProductionReasonSummary[];
  recentNoProposalDispatches: FleetProposalProductionDispatchSummary[];
  recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[];
}

export type FleetDispatchYieldDiagnosticVerdict =
  | 'actionable'
  | 'healthy'
  | 'insufficient-sample'
  | 'policy-suppressed';

export type FleetDispatchYieldDiagnosticAction =
  | 'route-same-tier-alternative'
  | 'tighten-context-or-reslice'
  | 'collect-more-samples'
  | 'keep-routing';

export interface FleetDispatchYieldDiagnosticCandidate {
  scope: 'fleet' | 'backend' | 'backend-model' | 'backend-source';
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  model?: string | null;
  diagnosticAttempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  policyDisabled: number;
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  sameTierOnly: boolean;
  topReason?: string;
  attemptShape?: DispatchProductionYieldSummary['attemptShape'];
  generatedRepairAttempts?: DispatchProductionYieldSummary['generatedRepairAttempts'];
}

export interface FleetDispatchYieldDiagnostics {
  windowHours: number;
  minAttempts: number;
  lowYieldRate: number;
  diagnosticAttempts: number;
  proposalsCreated: number;
  proposalRate: number;
  policyDisabled: number;
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  sameTierOnly: boolean;
  recommendation: string;
  topReason?: string;
  attemptShape?: DispatchProductionYieldSummary['attemptShape'];
  generatedRepairAttempts?: DispatchProductionYieldSummary['generatedRepairAttempts'];
  primaryCandidate?: FleetDispatchYieldDiagnosticCandidate;
  candidates: FleetDispatchYieldDiagnosticCandidate[];
}

export interface FleetDispatchManifestRecent {
  manifestId: string;
  ts: string;
  assigned: number;
  unassigned: number;
  backends: Record<string, number>;
  resourceSnapshotAt?: string;
}

export interface FleetDispatchManifestStatus {
  events: number;
  latestAt: string | null;
  assigned: number;
  unassigned: number;
  byBackend: Array<{ backend: string; assignments: number }>;
  recent: FleetDispatchManifestRecent[];
}

export interface FleetQueueNextItem {
  id: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  score: number;
}

export interface FleetQueueInventorySourceStatus {
  provenance: 'persisted-backlog' | 'queued-autonomy';
  sourceState: 'complete' | 'missing' | 'unavailable';
  freshness: 'fresh' | 'stale' | 'unknown' | 'empty';
  observedAt: string | null;
  visibleItems: number;
  actionableItems: number;
  detail: string;
}

export interface FleetQueueGeneratedWorkStatus {
  total: number;
  selfHeal: number;
  proposalRepair: number;
  captureRepairs: number;
  diagnosticReslices: number;
  diagnosticResliceDrainStalled?: boolean;
  invent: number;
}

export interface FleetGeneratedRepairRouteStatus {
  scope: 'eligible-claim-candidates';
  authority: 'observation-only';
  trustedItems: number;
  feasibleItems: number;
  unavailableItems: number;
  requiresAlternativeItems: number;
  byReason: Array<{ reason: GeneratedRepairRouteReason; count: number }>;
  blockedItems?: Array<{
    itemId: string;
    reason: Exclude<GeneratedRepairRouteReason, 'feasible'>;
  }>;
  blockedItemsOmitted?: number;
}

export interface FleetQueueScannerEvidenceStatus {
  state: 'healthy' | 'degraded' | 'unknown';
  observations: number;
  present: number;
  absent: number;
  unavailable: number;
  scannerDomains: number;
}

export interface FleetResolutionObserverStatus extends ResolutionObserverStatus {
  freshness: 'missing' | 'current' | 'stale' | 'degraded';
  lagMs: number | null;
}

export interface FleetActiveWorkStatus {
  source: 'daemon-spend-guard';
  path: string;
  exists: true;
  malformed: boolean;
  pid: number | null;
  hostname: string | null;
  armedAt: string | null;
  ageMs: number | null;
  itemCount: number;
  itemIds: string[];
  error?: string;
}

export interface FleetDiagnosticResliceDrainStatus {
  mode: 'diagnostic-reslices';
  latestAt: string;
  available: number;
  selected: number;
  limit?: number;
  capped?: boolean;
  automatic?: boolean;
  selectedItemIds?: string[];
  stalled?: boolean;
  dispatched: number;
  skipped: number;
  errors: number;
  proposalsCreated: number;
  noProposalDispatches: number;
  topReasons?: Array<{ reason: string; count: number }>;
}

export interface FleetRepairHandoffRolloutStatus {
  summaryAvailable: boolean;
  writerConfigured: boolean;
  writerEnabled: boolean;
  writerEffective: boolean;
  writerBlockedReason: 'missing-activation' | 'activation-in-future' | 'shared-queue-filesystem' | 'source-degraded' | null;
  activationId: string | null;
  activatedAt: string | null;
  phase: 'reader-only' | 'awaiting-evidence' | 'v2-healthy' | 'mixed-healthy' | 'blocked' | 'degraded';
  sourceState: 'missing' | 'healthy' | 'degraded';
  v1Authorities: number | null;
  v2Authorities: number | null;
  v1PhysicalRows: number | null;
  v2PhysicalRows: number | null;
  aliasFamilies: number | null;
  latestV2At: string | null;
  currentActivationV2Authorities: number | null;
  unboundV2Authorities: number | null;
  latestCurrentActivationV2At: string | null;
  authorityDigest: string | null;
  projectionObserved: boolean;
  projectionTickAt: string | null;
  invalidRows: number | null;
  conflictingIds: number | null;
  limitExceeded: boolean | null;
  eligibleOrdinaryItems: number | null;
  action: 'enable-canary' | 'wait-ordinary-parent' | 'observe-writer' | 'observe-projection' | 'retain-writer' | 'inspect-source' | 'repair-writer-config' | 'rollback-writer';
}

export interface RepairHandoffWriterRuntime {
  activationAware?: boolean;
  effective?: boolean;
  blockedReason?: FleetRepairHandoffRolloutStatus['writerBlockedReason'];
  activation?: RepairHandoffV2Activation;
}

export interface FleetQueueRepoCoverage {
  enrolled: number;
  existing: number;
  withBacklog: number;
  silent: number;
  /** Present only when the read-only enrollment authority could not be proven. */
  registry?: {
    state: 'degraded';
    reason: string;
  };
  executionProfiles?: {
    reposWithProjects: number;
    reposWithVerifyCommands: number;
    reposMissingVerifyCommands: number;
    reposWithVerifyContracts: number;
    reposWithValidVerifyContracts: number;
    reposWithExplicitMergeContracts: number;
    reposMissingExplicitMergeContracts: number;
    missingVerifyCommands?: Array<{
      repo: string;
      name: string;
      projectKinds: RepoProjectKind[];
      reason: string;
    }>;
    missingExplicitMergeContracts?: Array<{
      repo: string;
      name: string;
      projectKinds: RepoProjectKind[];
      reason: string;
    }>;
    packageManagers: Array<{ manager: RepoPackageManager; repos: number }>;
  };
  top: Array<{ repo: string; items: number }>;
  byTier: Array<{ tier: StrategicTier; repos: number; items: number }>;
}

/** Bounded non-authoritative projection of the shadow canary store. */
export interface FleetAutoMergeCanaryTelemetry {
  shadowCounters: AutoMergeCanaryShadowCountersV1 | null;
  outcomeRates: {
    eligible: number | null;
    rejected: number | null;
    bindingMismatch: number | null;
    inspectionError: number | null;
  };
  casRetries: number | null;
  revisionCapacity: {
    maximum: number;
    used: number | null;
    remaining: number | null;
    reservedForTerminal: 1;
    observationWritesRemaining: number | null;
  };
  epochAgeMs: number | null;
  observationDeadlineRemainingMs: number | null;
  lastShadowEvidence: {
    observedAt: string;
    outcome: AutoMergeCanaryShadowEvidenceV1['outcome'];
    mismatchFields: AutoMergeCanaryShadowEvidenceV1['mismatchFields'];
    fileCount: number;
    lineCount: number;
  } | null;
}

export interface FleetAutoMergeCanaryStatus {
  authority: 'observation-only';
  policyEligible: false;
  enforceSupported: false;
  hostCancellationProven: false;
  sourceState: AutoMergeCanaryReadResult['sourceState'];
  severity: AutoMergeCanaryReadResult['severity'];
  status: AutoMergeCanaryReadResult['status'];
  active: boolean;
  current: {
    epochId: string;
    revision: number;
    mode: 'shadow';
    state: 'shadow' | 'halt-requested' | 'halted';
    activatedAt: string;
    updatedAt: string;
    budgets: AutoMergeCanaryBudgetsV1;
    counters: AutoMergeCanaryCountersV1;
    blocker: AutoMergeCanaryBlockerV1 | null;
  } | null;
  telemetry: FleetAutoMergeCanaryTelemetry;
  revisionCount: number | null;
  terminalEpochCount: number | null;
  diagnostics: AutoMergeCanaryReadResult['diagnostics'];
  limitExceeded: boolean;
}

export type FleetLearningSourceName =
  | 'dispatch-production'
  | 'agent-actions'
  | 'outcomes'
  | 'decisions'
  | 'evidence'
  | 'worked'
  | 'post-merge'
  | 'judge-traces'
  | 'skill-use';

export type FleetLearningWithholdingReason = `${FleetLearningSourceName}-source-missing` |
  `${FleetLearningSourceName}-source-degraded`;

export interface FleetLearningSourceAvailability {
  source: FleetLearningSourceName;
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
}

export interface FleetLearningMetricAvailability {
  state: 'available' | 'partial' | 'withheld';
  reasons: FleetLearningWithholdingReason[];
  sources: FleetLearningSourceAvailability[];
  withheldMetrics: string[];
}

/** One whole-fleet read-only snapshot. */
export interface FleetStatus {
  /** Advisory per-pool observations, independent of dispatch authority. */
  budgets?: PoolBudgetSnapshot;
  /** ISO timestamp this snapshot was generated. */
  generatedAt: string;
  /** Canonical build-produced identity. Optional for legacy serialized snapshots. */
  buildIdentity?: BuildIdentity;
  daemon: {
    running: boolean;
    sourceQuality?: {
      sourceState: 'healthy' | 'degraded';
      complete: boolean;
      reason: 'healthy' | 'missing' | 'malformed' | 'unreadable' | 'inconsistent' | 'unavailable';
    };
    pid?: number | null;
    startedAt?: string | null;
    lastTickAt: string | null;
    lockHeartbeatAt?: string | null;
    tickInProgress?: boolean;
    /**
     * Additive (observational, authority none): what the running daemon's
     * current tick is doing and for how long - present only while a tick is
     * open (daemon/tick-progress.ts). Unlike `tickInProgress` it does not
     * need a fresh activity heartbeat, so a tick whose event loop is stuck
     * still says where it is.
     */
    tickProgress?: {
      phase: string;
      detail: string | null;
      tickStartedAt: string;
      phaseStartedAt: string;
      tickAgeMs: number;
      phaseAgeMs: number;
      /** `tick in progress: <phase> for <duration>`. */
      summary: string;
    };
    childActivity?: boolean;
    activity?: {
      source: 'daemon-activity';
      sourceState: 'missing' | 'healthy' | 'degraded';
      freshness: 'fresh' | 'stale' | 'future' | 'unknown';
      ownerState: 'alive' | 'dead' | 'reused' | 'unknown';
      phase: 'starting' | 'tick' | 'post-tick' | 'idle' | 'stopping' | null;
      phaseStartedAt: string | null;
      observedAt: string | null;
      ageMs: number | null;
      activeChildren: number | null;
      ownerMatches: boolean;
    };
    todaySpentUsd: number;
    activation?: DaemonActivationReadiness;
  };
  backends: FleetBackendStatus[];
  queue: {
    backlogItems: number;
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    repairRouteBlockedItems?: number;
    repairControlBlockedItems?: number;
    repairLifecycleUnavailableItems?: number;
    repairTerminalItems?: number;
    repairQuarantinedItems?: number;
    nextEligibleAt?: string | null;
    repos?: FleetQueueRepoCoverage;
    next?: FleetQueueNextItem[];
    sources?: {
      cachedBacklog: FleetQueueInventorySourceStatus;
      queuedAutonomy: FleetQueueInventorySourceStatus;
    };
    shared?: FleetSharedQueueStatus;
    activeWork?: FleetActiveWorkStatus;
    generatedWork?: FleetQueueGeneratedWorkStatus;
    generatedRepairRoutes?: FleetGeneratedRepairRouteStatus;
    scannerEvidence?: FleetQueueScannerEvidenceStatus;
    resolutionObserver?: FleetResolutionObserverStatus;
    diagnosticResliceDrain?: FleetDiagnosticResliceDrainStatus;
  };
  repairHandoffRollout?: FleetRepairHandoffRolloutStatus;
  proposals: {
    /** Observed inventory only; authority consumers must also require `authority.gate === 'ready'`. */
    pending: number;
    frontierPending: number;
    awaitingHostMerge?: number;
    applied: number;
    sourceQuality?: FleetProposalSourceQuality;
    authority?: FleetProposalAuthoritySource;
  };
  merges: {
    recent: number;
    /** Legacy daemon-reported merge activity. Forensics only; never landed-work authority. */
    reportedByTicks?: number;
    /** Completeness of the proposal source that backs `recent`. */
    sourceQuality?: FleetProposalSourceQuality;
  };
  /** Values-free Phantom readiness for fleet secret operations. */
  phantom?: FleetPhantomStatus;
  autonomy?: FleetAutonomyStatus;
  /** Effective autonomy control authority for daemon dispatch decisions. */
  autonomyControlMode: FleetAutonomyControlMode;
  /** Read-only static readiness summary for pending auto-merge candidates. */
  autoMergeReadiness?: FleetAutoMergeReadinessStatus;
  /** Observation-only shadow canary state; never consumed by fleet policy. */
  autoMergeCanary?: FleetAutoMergeCanaryStatus;
  /** Observation-only explanation of future canary promotion prerequisites. */
  autoMergeCanaryPromotionReadiness?: AutoMergeCanaryPromotionReadiness;
  /** Read-only resource-aware autonomous operating recommendation. */
  autonomyDirection?: FleetAutonomyDirectionSummary;
  /** Read-only diagnosis of guard state that can block autonomous work. */
  guardHealth?: GuardHealthDiagnosis;
  /** Ranked read-only operator/agent actions derived from the snapshot. */
  nextActions?: FleetNextAction[];
  /** Read-only focus policy summary for active goal closure over queue widening. */
  goalFocus?: FleetGoalFocusStatus;
  /** Read-only derived view of occupied work lanes; does not affect dispatch. */
  laneLocks?: FleetLaneLocksStatus;
  /** Read-only explanation of whether the autonomous loop can merge right now. */
  autonomyEffectiveness?: FleetAutonomyEffectivenessStatus;
  /** Read-only Fleet OS verdict for whether autonomous shipping is ready now. */
  autonomousShipReadiness?: FleetAutonomousShipReadinessStatus;
  /** Single-command operating brief derived from readiness, effectiveness, and next actions. */
  missionBrief?: FleetMissionBrief;
  /** Read-only diagnosis of recent proposal production from daemon ticks. */
  proposalProduction?: FleetProposalProductionStatus;
  /** Durable 24h dispatch-production yield summary from the append-only ledger. */
  dispatchProduction?: DispatchProductionYieldSummary;
  /** Storage/read completeness for dispatch-production analytics. */
  dispatchProductionSource?: DispatchProductionSourceQuality;
  /** Metadata-only proposal-funnel rates; withheld whenever the bounded source is incomplete. */
  proposalFunnel?: ProposalFunnelObservability;
  /** Whether dispatch-backed learning metrics have a complete denominator. */
  learningMetrics?: {
    state: 'available' | 'withheld';
    denominator: 'dispatch-production';
    reason?:
      | 'dispatch-source-missing'
      | 'dispatch-source-degraded'
      | 'learning-snapshot-settling'
      | 'learning-snapshot-unstable';
    /** Exact upper timestamp bound shared by every joined learning source. */
    settledThrough?: string;
    /** Valid rows intentionally excluded because they are newer than settledThrough. */
    excludedRows?: number;
    sourceQuality: DispatchProductionSourceQuality;
    dispatchProduction: FleetLearningMetricAvailability;
    attemptCoverage?: FleetLearningMetricAvailability;
    trajectoryLearning?: FleetLearningMetricAvailability;
  };
  /** Fail-closed authority projection for whether learned history may steer live routing. */
  routingLearningAuthority?: RoutingLearningAuthority;
  /** Storage/read completeness for cached judge and merge-authority evidence. */
  decisionsSource?: DecisionSourceQuality;
  /** Storage/read completeness for judge calibration and real-world outcome labels. */
  judgeTraceSource?: JudgeTraceSourceQuality;
  /** Recent forensic concurrent dispatch intent summaries from the append-only manifest ledger. */
  dispatchManifests?: FleetDispatchManifestStatus;
  /** Storage/read completeness for forensic concurrent dispatch intent. */
  dispatchManifestSource?: DispatchManifestSourceQuality;
  /** Bounded candidate-economics evidence used only when complete. */
  bestOfNSource?: BestOfNSourceQuality;
  /** Observation-only post-merge evidence. Never grants routing or merge authority. */
  postMergeSource?: FleetReadinessEvidenceQuality;
  postMergeCohort?: {
    policyEligible: false;
    denominatorComplete: false;
    adverseObservations: number;
    stability: PostMergeStabilityCohortSummary;
  };
  /** Authenticated metadata from detached post-merge verification runners. */
  detachedPostMergeVerificationSource?: FleetReadinessEvidenceQuality;
  /** Authenticated current candidate denominator for detached verification. */
  detachedPostMergeDenominatorSource?: FleetReadinessEvidenceQuality;
  /** Immutable data-only work tickets. Queue state grants no execution or readiness authority. */
  detachedPostMergeWorkTicketSource?: FleetReadinessEvidenceQuality;
  /** Read-only detached cohort quality. It is excluded from policy authority. */
  detachedPostMergeVerificationReadiness?: FleetDetachedPostMergeVerificationReadiness;
  /** Authenticated checkpoint availability. Excluded from readiness and policy inputs. */
  cutoffCheckpoints?: FleetCutoffCheckpointStatus;
  /** Effective applicability for optional evidence producers. */
  evidencePolicy?: {
    concurrentDispatchEnabled: boolean;
    bestOfNEnabled: boolean;
  };
  /** Sample-gated diagnosis of dispatch-production yield; no raw prompts/diffs/stdout. */
  dispatchYieldDiagnostics?: FleetDispatchYieldDiagnostics;
  /** Durable 24h agent-action global workspace summary from append-only telemetry. */
  workspace?: AgentWorkspaceStatus;
  /** Read-only joined attempt coverage summary; metadata only, no raw prompts/diffs/output. */
  attemptCoverage?: AttemptCoverageStatus;
  /** Read-only route-to-outcome trajectory reconstruction summary; metadata only. */
  trajectoryLearning?: TrajectoryLearningStatus;
  /** Read-only signed skill-corpus health and privacy-gated observation state. */
  skillCorpusReadiness?: FleetSkillCorpusReadiness;
  /** Read-only context discipline signal for long-running multi-agent work. */
  contextEfficiency?: FleetContextEfficiencyStatus;
  /** True when the global kill switch is engaged (fleet paused). */
  killed: boolean;
  /** Exact observation of kill-switch authority. Legacy `killed` stays restrictive. */
  killSwitch?: {
    state: 'active' | 'inactive' | 'unknown';
    sourceState: 'healthy' | 'degraded';
    reason: 'present' | 'missing' | 'uninspectable' | 'unsafe' | 'unavailable';
  };
}

export interface FleetQueueEligibility {
  eligibleItems: WorkItem[];
  cooldownItems: number;
  pendingItems: number;
  repairRouteBlockedItems: number;
  repairControlBlockedItems: number;
  repairLifecycleUnavailableItems: number;
  repairTerminalItems: number;
  repairQuarantinedItems: number;
  generatedRepairRoutes?: FleetGeneratedRepairRouteStatus;
  nextEligibleAt: string | null;
}

export type LearningSourceQualityLike = {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
};

export interface FleetDaemonStatusRead {
  daemon: FleetStatus['daemon'];
  recentTicks: DaemonTick[];
}

export interface PhantomAuditSignalSummary {
  detail: string;
  signals: string[];
}

export interface AutonomousShipReadinessInputs {
  generatedAt: string;
  queueSnapshotAt: string | null;
  queueSourceStatus: FleetReadinessSourceStatus;
  queueSourceDetail: string;
}
