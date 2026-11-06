/** Shared learning contracts. Public entry point: ../types.ts. */
import type { EngineId, EngineTier } from './engines.js';
import type { GenomeHealth } from './genome.js';
import type { AutoMergeTrustBasis } from './proposals.js';
import type { RunTokenEvidence } from './run.js';

export type LearningSource =
  | 'proposal'
  | 'decision-ledger'
  | 'daemon-dispatch'
  | 'agent-action'
  | 'autonomy-evidence'
  | 'outcome-record'
  | 'worked-ledger'
  | string;

export type LabelBasis =
  | 'proposal-status'
  | 'dispatch-outcome'
  | 'judge-verdict'
  | 'merge-gate'
  | 'autonomy-policy'
  | 'evidence-policy'
  | 'manual-decision'
  | 'unknown'
  | string;

export type AgentSemanticEventKind =
  | 'intent'
  | 'observation'
  | 'prediction'
  | 'action'
  | 'evidence'
  | 'challenge';

interface AgentSemanticEventBaseV1 {
  schemaVersion: 1;
  /** Deterministic `ase-<sha256>` identity over the complete event payload. */
  eventId: string;
  /** Producer-local ordering. Persisted sets are bounded to 16 events. */
  sequence: number;
  kind: AgentSemanticEventKind;
  /** Closed machine predicate, never prose. */
  predicate: string;
  /** Parent-bound opaque durable id (`proposal:<id>`, `run:<id>`, or `trajectory:<id>`). */
  subjectRef: string;
  producerRole: 'manager' | 'agent' | 'verifier' | 'observer' | 'system';
  /**
   * V3.10 adds `xai`: Grok was filed under `local`, which let a Grok producer
   * and a local judge count as the SAME family (and a Grok judge could never be
   * independent of local work). xAI is its own provider family.
   */
  producerModelFamily: 'claude' | 'openai' | 'xai' | 'local' | 'unknown';
  producerVersion:
    | 'manager-semantic-v1'
    | 'agent-semantic-v1'
    | 'verifier-semantic-v1'
    | 'system-semantic-v1'
    | 'test-semantic-v1';
  /** Opaque occurrence identity; preserved unchanged through every projection. */
  sourceRef: string;
}

export type AgentSemanticEventV1 =
  | (AgentSemanticEventBaseV1 & {
      kind: 'intent';
      objectiveCode: string;
    })
  | (AgentSemanticEventBaseV1 & {
      kind: 'observation';
      metricCode: string;
      value: number;
      unit: 'score-1-5' | 'boolean' | 'count' | 'ratio';
    })
  | (AgentSemanticEventBaseV1 & {
      kind: 'prediction';
      outcomeCode: string;
      probability: number;
      horizon: 'decision' | 'verification' | 'post-merge';
    })
  | (AgentSemanticEventBaseV1 & {
      kind: 'action';
      actionCode: string;
      status: 'planned' | 'started' | 'completed' | 'blocked';
    })
  | (AgentSemanticEventBaseV1 & {
      kind: 'evidence';
      evidenceCode: string;
      result: 'supports' | 'contradicts' | 'inconclusive';
    })
  | (AgentSemanticEventBaseV1 & {
      kind: 'challenge';
      challengeCode: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      targetEventId?: string;
    });

export interface RouteSnapshot {
  backend?: EngineId | string | null;
  tier?: EngineTier | string | null;
  model?: string | null;
  assignedBy?: string;
  reason?: string;
  routerPolicyVersion?: string;
  /** Metadata-only ids selected by the skill policy for this route. */
  selectedSkillIds?: string[];
  /** Version of the skill selection policy that produced the selection. */
  skillPolicyVersion?: string;
  /** Whether selected skills were observed, applied, or disabled. */
  skillMode?: 'shadow' | 'active' | 'disabled';
}

export interface PromptContextSummary {
  role?: 'planner' | 'executor' | 'synthesizer' | 'judge';
  profileId?: string;
  contextWindowTokens?: number;
  providerPromptTokens?: number;
  estimatedPromptTokens?: number;
  promptCharCap?: number;
  assembledSystemChars?: number;
  promptBudgetRatio?: number;
  contextWindowRatio?: number;
  layersIncluded?: Array<'base' | 'tool' | 'output' | 'role' | 'memory'>;
  toolCount?: number;
  cacheHit?: boolean;
}

export interface RetrievalContextSummary {
  source?: 'genome' | 'playbook' | 'local-context' | 'repo-map' | 'localize';
  requestedLimit?: number;
  corpusEntries?: number;
  candidateCount?: number;
  hitCount: number;
  injectedHitCount?: number;
  limitHitRate?: number;
  candidateHitRate?: number;
  methodCounts?: { keyword?: number; embedding?: number };
  topScore?: number;
  injectedChars?: number;
}

export interface CompressionContextSummary {
  source?: 'prompt-budget' | 'playbook' | 'local-context' | 'reflection';
  strategy?: 'truncate' | 'drop-layer' | 'synthesize' | 'fallback-summary';
  inputChars?: number;
  outputChars?: number;
  maxChars?: number;
  droppedChars?: number;
  compressionRatio?: number;
  truncated?: boolean;
  droppedLayers?: string[];
}

export interface RunContextSummary {
  prompt?: PromptContextSummary;
  retrieval?: RetrievalContextSummary;
  compression?: CompressionContextSummary;
}

export interface RunActionCounts {
  sandboxCreated?: number;
  spawnAttempts?: number;
  transientRetries?: number;
  proposalCaptureAttempts?: number;
  completenessGateRuns?: number;
  verifyRepairAttempts?: number;
  modelSteps?: number;
  toolSteps?: number;
  totalSteps?: number;
  diffFiles?: number;
  diffLines?: number;
  proposalCreated?: number;
  proposalBlocked?: number;
  proposalDisabled?: number;
}

export interface ProductionAttemptShape {
  backendNoDiff: number;
  captureOrGateBlocked: number;
  repairAttempts: number;
  policyDisabled: number;
}

export interface RunEventSummary {
  runId?: string;
  status?: string;
  outcome?: string;
  proposalCreated?: boolean;
  proposalId?: string;
  diffFiles?: number;
  diffLines?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  cacheHit?: boolean;
  /** Metadata-only context utilization/retrieval/compression signals. */
  contextSummary?: RunContextSummary;
  tokenEvidence?: RunTokenEvidence;
  /** Metadata-only fixed-key sandbox/action counters. */
  actionCounts?: RunActionCounts;
}

export interface EvidenceOutcomeSummary {
  target?: string;
  trustBasis?: AutoMergeTrustBasis | string;
  riskClass?: string;
  verificationPassed?: boolean;
  policyAllowed?: boolean;
  policyAction?: string;
  policyTier?: string;
  gateCount?: number;
}


// ---------------------------------------------------------------------------
// M26: SELF-IMPROVEMENT / META-LEARNING - `ashlr reflect`
//
// The reflection loop scores the org's OWN past swarms/runs/usage, distills
// playbooks, and proposes routing/policy/prompt tuning. SAFE BY CONSTRUCTION:
//   - READ-ONLY over history (swarms, genome, usage). Writes ONLY under
//     ~/.ashlr/learn/ (reports, snapshots) and - only on `reflect propose` -
//     to the M23 Approval Inbox via createProposal() (status pending).
//   - NEVER mutates config.json / router policy / prompts / any user repo.
//   - The METRICS engine is DETERMINISTIC and computed WITHOUT any LLM. Only
//     optional narrative/playbook TEXT may route through getActiveClient
//     (local-only unless --allow-cloud + a key), mirroring M25 ask.ts.
//   - BOUNDED: reads at most `maxRuns` recent swarms / a `--since` window.
// These types carry METADATA ONLY - never secret values, never raw payloads.
// ---------------------------------------------------------------------------

/**
 * M26: one clustered failure mode distilled from failed/aborted swarms and
 * failed tasks. Built deterministically by clustering normalized task.error
 * strings / failed phase names. No LLM. METADATA ONLY.
 */
export interface FailureMode {
  /** Stable cluster key (normalized error signature or phase name). */
  key: string;
  /** Human-readable label for the cluster. */
  label: string;
  /** Number of failed tasks/swarms that fell into this cluster. */
  count: number;
  /** Which swarm phase(s) this failure most often occurred in. */
  phases: string[];
  /** A few representative swarm ids exhibiting this failure (bounded sample). */
  exampleSwarmIds: string[];
}

/**
 * M26: per-goal-category aggregation - the slowest / most-expensive kinds of
 * work, derived deterministically by bucketing swarm goals into coarse
 * categories (keyword heuristic). No LLM. METADATA ONLY.
 */
export interface GoalCategoryStat {
  /** Coarse category label (e.g. 'refactor', 'feature', 'bugfix', 'docs', 'other'). */
  category: string;
  /** Number of swarms in this category within the window. */
  swarms: number;
  /** Mean estimated USD cost per swarm in this category. */
  avgCostUsd: number;
  /** Mean total tokens (in+out) per swarm in this category. */
  avgTokens: number;
  /** Success rate (done / total) for this category, 0..1. */
  successRate: number;
}

/**
 * M26: week-over-week (snapshot-over-snapshot) deltas vs the previous persisted
 * ReflectionReport. All deltas are computed deterministically by diffing the
 * current metrics against the prior snapshot loaded from
 * ~/.ashlr/learn/reports/. Absent fields => no prior snapshot to compare.
 */
export interface ReflectionDelta {
  /** ISO timestamp of the prior snapshot this delta compares against, or null. */
  previousAt: string | null;
  /**
   * Change in effectiveness, expressed as a signed percentage-point delta of
   * success rate (e.g. +12 means "12 points more effective"). null when no prior.
   */
  effectivenessPct: number | null;
  /**
   * Change in average cost per swarm, expressed as a signed percentage
   * (e.g. -18 means "18% cheaper"). null when no prior.
   */
  costPct: number | null;
  /** Signed percentage-point change in local-vs-cloud share. null when no prior. */
  localSharePct: number | null;
  /** One-line human summary of the headline movements (deterministic template). */
  headline: string;
}

/**
 * M26: the deterministic reflection report. Persisted as a snapshot under
 * ~/.ashlr/learn/reports/<ts>.json and used as the prior for the next run's
 * week-over-week deltas. Computed entirely WITHOUT an LLM (an optional
 * narrative field may be added later by playbooks.ts, but is never required).
 * METADATA ONLY - never carries secret values or raw code/payloads.
 */
export interface ReflectionReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** ISO lower bound of the analysis window (inclusive). */
  since: string;
  /** Window label when derived from --since (e.g. '7d'/'30d'), else null. */
  window: string | null;
  /** How many swarms were actually read (bounded by maxRuns/since). */
  swarmsAnalyzed: number;
  /** Count of swarms with status 'done'. */
  swarmsDone: number;
  /** Count of swarms with status 'failed' or 'aborted'. */
  swarmsFailed: number;
  /** Success rate: swarmsDone / swarmsAnalyzed (0..1; 0 when none). */
  successRate: number;
  /** Mean estimated USD cost per analyzed swarm. */
  avgCostUsd: number;
  /** Mean total tokens (in+out) per analyzed swarm. */
  avgTokens: number;
  /** Total estimated USD cost across analyzed swarms. */
  totalCostUsd: number;
  /** Share of token usage served by LOCAL providers (0..1) from usage events. */
  localShare: number;
  /** Top clustered failure modes, most frequent first (bounded). */
  topFailures: FailureMode[];
  /** Slowest / most-expensive goal categories, most-expensive first (bounded). */
  goalCategories: GoalCategoryStat[];
  /** Week-over-week deltas vs the prior snapshot (templated, deterministic). */
  delta: ReflectionDelta;
  /** Genome health snapshot at report time (entry counts etc.). */
  genome: GenomeHealth;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when no narrative. */
  narrativeLocal?: boolean;
}

/**
 * M26: a single PROPOSAL-ONLY tuning suggestion derived from a ReflectionReport.
 * These NEVER auto-apply: emitTuningProposals() routes each one to the M23
 * Approval Inbox as a PENDING proposal (kind 'note' - a no-op record that
 * mutates nothing), or the report prints them. There is NO code path that writes
 * config.json / router policy / prompts. METADATA ONLY.
 */
export interface TuningProposal {
  /** Stable suggestion key (e.g. 'routing.local-first-threshold'). */
  key: string;
  /** What aspect this suggestion concerns (purely descriptive; never applied). */
  area: 'routing' | 'policy' | 'prompt' | 'playbook';
  /** Short human-readable title for the inbox / report. */
  title: string;
  /** Longer rationale grounded in the report's deterministic metrics. */
  rationale: string;
  /** Confidence in the suggestion (0..1), derived from sample size / effect. */
  confidence: number;
}

/** Options accepted by `buildReflection` (the deterministic metrics engine). */
export interface ReflectionOptions {
  /** Analyze only swarms created at/after this epoch-ms lower bound. */
  sinceMs?: number;
  /** Hard cap on how many recent swarms to read (bounds I/O). */
  maxRuns?: number;
  /** Window label to record on the report (purely informational). */
  window?: string | null;
}
