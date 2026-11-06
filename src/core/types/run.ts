/** Shared run contracts. Public entry point: ../types.ts. */
import type { DevinCliExecutionBinding } from '../devin/cli-admission.js';
import type { WorkSource } from './backlog.js';
import type { DelegationScope, DelegationScopeSummary } from './delegation.js';
import type { EngineTier } from './engines.js';
import type { EvidenceOutcomeSummary, LabelBasis, LearningSource, RouteSnapshot, RunEventSummary } from './learning.js';

// ---------------------------------------------------------------------------
// M4: local-first agent orchestrator (`ashlr run`) contract
// ---------------------------------------------------------------------------

/** Hard guardrails for a single run. Budget/steps abort the run when exceeded. */
export interface RunBudget {
  /** Maximum total tokens (in + out) before the run aborts. */
  maxTokens: number;
  /** Maximum number of model/agent steps before the run aborts. */
  maxSteps: number;
  /** Whether cloud providers are permitted (default false = local-first refuse). */
  allowCloud: boolean;
}

/** Token + step accounting for a task or whole run. */
export type RunTokenBasis = 'reported' | 'estimated' | 'reserved' | 'unknown' | 'no-contact';
/** Diagnostic accounting only; absence on legacy records means unknown. */
export interface RunTokenEvidence {
  schemaVersion: 1;
  scope: 'recorded-model-requests';
  input: Record<Exclude<RunTokenBasis, 'no-contact'>, number>;
  output: Record<Exclude<RunTokenBasis, 'no-contact'>, number>;
  requests: Record<Exclude<RunTokenBasis, 'no-contact'> | 'noContact', number>;
  /** Unclassified legacy contributions, including zero; no request count invented. */
  unclassified: boolean;
}

export interface RunUsage {
  /** Accounted input exposure; tokenEvidence distinguishes reported usage. */
  tokensIn: number;
  /** Accounted output exposure; may include retained reservations. */
  tokensOut: number;
  /** Number of steps taken. */
  steps: number;
  /** Estimated USD cost (0 for local providers). */
  estCostUsd: number;
  /** Exact settled API charges and retained maximum exposure; never subscription quota. */
  apiBilling?: ApiBillingSummary;
  tokenEvidence?: RunTokenEvidence;
}

export interface ApiBillingSummary {
  provider: 'anthropic';
  settledUsdMicros: string;
  unknownExposureUsdMicros: string;
  settledRequests: number;
  unknownRequests: number;
}

export interface ApiMessageBilling {
  provider: 'anthropic';
  requestId: string;
  model: string;
  pricingDigest: string;
  serviceTier: 'standard';
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  actualUsdMicros: string;
  /**
   * Present only when the request went through an explicitly configured
   * gateway (`gateways.anthropic`). Host only: never the key, URL or path.
   */
  gateway?: { via: 'gateway'; host: string };
}

/** Lifecycle state of a single task in the run graph. */
export type RunTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** A single node in the run task-graph (DAG). */
export interface RunTask {
  /** Stable task id (unique within the run). */
  id: string;
  /** The sub-goal this task must accomplish. */
  goal: string;
  /** Ids of tasks that must complete before this one runs. */
  deps: string[];
  /** Current lifecycle status. */
  status: RunTaskStatus;
  /** Final task result text, present when done. */
  result?: string;
  /** Token/step usage attributed to this task. */
  usage?: RunUsage;
  /** Failure or cancellation reason, absent for successful/pending work. */
  error?: string;
}

/** An append-only event recorded during a run for audit/resume. */
export interface RunStep {
  /** ISO timestamp the step occurred. */
  ts: string;
  /** Id of the task this step belongs to. */
  taskId: string;
  /** What kind of step this was. */
  kind: 'plan' | 'model' | 'tool' | 'synthesize';
  /** One-line human-readable summary of the step. */
  summary: string;
  /** Usage incurred by this step, if any. */
  usage?: RunUsage;
}

export type RunProposalOutcomeKind =
  | 'filed'
  | 'empty-diff'
  | 'trivial-proposal'
  | 'completeness-gate'
  | 'partial-completeness-gate'
  | 'engine-failed-no-diff'
  | 'api-model-task-failed'
  | 'sandbox-unavailable'
  | 'engine-command-missing'
  | 'engine-unsupported'
  | 'kill-switch'
  | 'proposal-disabled'
  | 'proposal-capture-error';

export interface RunProposalOutcome {
  kind: RunProposalOutcomeKind;
  reason: string;
  /** True when the persisted proposal is incomplete review evidence, never ship authority. */
  isPartial?: boolean;
  proposalId?: string;
  files?: number;
  insertions?: number;
  deletions?: number;
}

/** Full persisted state of a run. Lives at ~/.ashlr/runs/<id>.json. */
export interface RunState {
  /** Stable run id. */
  id: string;
  /** The original top-level goal. */
  goal: string;
  /** Engine that executed the run ('builtin' | 'ashlrcode' | 'aw' | 'claude' | 'codex'). */
  engine: string;
  /** Active provider id used for the run. */
  provider: string;
  /**
   * M45: backend + model that produced this run, for merge-authority gating.
   * e.g. 'claude:claude-opus-4-8' | 'codex:gpt-5.5' | 'builtin:<local-model>'.
   */
  engineModel?: string;
  /** M45: trust tier of the producing backend ('local' | 'frontier'). */
  engineTier?: EngineTier;
  /** ISO timestamp the run was created. */
  createdAt: string;
  /** ISO timestamp of the last update (written after each step). */
  updatedAt: string;
  /** Guardrails in effect for this run. */
  budget: RunBudget;
  /** Cumulative usage across the whole run. */
  usage: RunUsage;
  /** The task-graph (DAG). */
  tasks: RunTask[];
  /** Append-only step log. */
  steps: RunStep[];
  /** Current run status. */
  status: 'running' | 'done' | 'aborted' | 'failed';
  /** Synthesized final answer, present when done. */
  result?: string;
  /** Metadata-only reason a sandboxed autonomous run did or did not file a proposal. */
  proposalOutcome?: RunProposalOutcome;
  /** Stable attempt/work trajectory id for joining runs, proposals, and ledgers. */
  trajectoryId?: string;
  /** Metadata-only route snapshot; never includes prompts or engine output. */
  routeSnapshot?: RouteSnapshot;
  /** Metadata-only run summary; never includes prompts, diffs, stdout, or stderr. */
  runEventSummary?: RunEventSummary;
  /** Metadata-only autonomy evidence outcome associated with this run, when one exists. */
  evidenceOutcome?: EvidenceOutcomeSummary;
  /** Bounded delegation constraints/expectations; never includes raw prompt/output text. */
  delegationScope?: DelegationScopeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  /**
   * Why an external run was stopped, including explicit caller cancellation.
   */
  terminationReason?: 'idle-stall' | 'loop-stall' | 'no-diff-stall' | 'backstop-timeout' | 'cancelled' | 'clean-exit' | 'error-exit';
  /** Original host termination request remains distinct from a later cleanup failure. No argv/output. */
  terminationDiagnostics?: {
    initiator: 'idle-stall' | 'loop-stall' | 'no-diff-stall' | 'backstop-timeout' | 'cancelled' | 'clean-exit' | 'error-exit';
    requestedAt: string;
    leaderExitedAt: string | null;
    cleanupAuthorityLost: boolean;
  };
}

/**
 * In-memory authority over an atomically pre-reserved provider-contact set.
 *
 * The function is intentionally non-serializable. A persisted run/swarm may
 * retain the opaque attempt id for correlation, but can never reconstruct the
 * right to consume another ticket after a restart or resume.
 */
export interface ProviderInferenceQuotaSession {
  readonly attemptId: string;
  claimNext(): string;
}

/** Options accepted by `runGoal` / the `ashlr run` CLI. */
export interface RunOptions {
  /** Optional caller-owned cancellation signal for this run. */
  signal?: AbortSignal;
  /**
   * Exact routed native account for Codex or Grok. Grok resolves this profile
   * freshly and uses its private native-state copy; it never substitutes the
   * configured default account when an explicit binding cannot be resolved.
   */
  seatId?: string;
  /** Internal synchronous same-seat authority fence; never serialized or passed to a model. */
  selectedGrokAdmission?: () => boolean;
  /** Host-issued exact native Devin principal/model binding; never serialized or sent to a model. */
  selectedDevinAdmission?: (model: string) => DevinCliExecutionBinding | null;
  /** Host-only notification after an admitted native Devin child actually spawns; never grants billing authority. */
  onSelectedDevinSpawn?: (model: string, binding: DevinCliExecutionBinding) => void;
  /** Host-only exact selected Claude account/authority fence; never model input. */
  selectedClaudeAdmission?: () => boolean;
  /** Original routed Codex principal plus current host admission; never serialized. */
  selectedCodexAccount?: { readonly accountHint: string; admitted(): boolean };
  /** Internal caller-owned outcome revision fence; never persisted or sent to a model. */
  selectedOutcomeAdmission?: () => boolean;
  /** Partial budget overrides (merged over defaults). */
  budget?: Partial<RunBudget>;
  /** Max independent tasks to execute in parallel. */
  parallel?: number;
  /** Engine selector ('builtin' | 'ashlrcode' | 'aw'). */
  engine?: string;
  /**
   * Optional concrete model chosen by the router/gateway for this run. When set,
   * external CLI/API engines use it instead of ASHLR_MODEL / AC_MODEL.
   */
  model?: string;
  /** Whether to load aggregated MCP tools (default true). */
  tools?: boolean;
  /** Whether cloud providers are permitted. */
  allowCloud?: boolean;
  /**
   * Absolute working directory the run operates in (e.g. a swarm task's target
   * project dir). When set, engine delegation uses this as the spawn cwd so the
   * agent acts WITHIN the intended project, not wherever the parent launched.
   * Defaults to process.cwd() when unset.
   */
  cwd?: string;
  /** Existing run id to resume from cache. */
  resumeId?: string;
  /** Caller-preallocated opaque id for a fresh run; ignored when resumeId is set. */
  runId?: string;
  /** Optional advisory delegation contract for spawned/sandboxed agents. */
  delegationScope?: DelegationScope;
  /** Emit machine-readable JSON instead of human output. */
  json?: boolean;
  /** Disable genome recall injection into the sub-agent system prompt (M7). */
  noMemory?: boolean;
  /** Disable post-run genome capture. Required by signed one-shot execution. */
  noCapture?: boolean;
  /**
   * Non-serializable, caller-owned authority for one pre-reserved provider
   * inference ticket per governed model call. Ordinary/manual runs omit this.
   */
  providerQuota?: ProviderInferenceQuotaSession;
  /**
   * Enable the optional cheap MODEL verification check after each builtin task
   * (M11). Default false → heuristic-only verification (no extra model calls,
   * preserving deterministic usage accounting). When true, verifyTask may make
   * one cheap model call per task plus one verify-driven retry, all bounded by
   * the global budget.
   */
  verifyModel?: boolean;
  /**
   * M42: enable the in-process engineering tool surface - read_file/glob/grep
   * plus sandboxed write_file/edit_file (and, with allowBash, bash/run_tests).
   * Default false → the run keeps today's spec-only gateway tools and never
   * writes. All writes land in a throwaway git worktree; the captured diff is
   * routed to the approval inbox as a PENDING proposal, never the live tree.
   */
  engineer?: boolean;
  /** M42: additionally enable the bash/run_tests exec tools (requires engineer). */
  allowBash?: boolean;
  /**
   * M43: max verify→repair iterations per task on a failing structured verify
   * (typecheck/lint/build/test). Default 2; 0 disables the repair loop. Each iteration
   * is bounded by the per-task step cap and the global budget.
   */
  maxRepairs?: number;
  /**
   * M45: when true, an external engine ('claude'|'codex'|…) runs INSIDE a
   * throwaway sandbox worktree with its diff captured to the inbox, instead of
   * raw on the live tree. Set by the swarm/daemon for autonomous external runs.
   */
  sandboxEngine?: boolean;
  /** M45: abort (no raw fallback) if a sandbox worktree cannot be created. */
  requireSandbox?: boolean;
  /** Optional originating backlog/work item id for causal tracing. */
  workItemId?: string;
  /** Hash binding generated repair proposals to one immutable source generation. */
  workItemGenerationId?: string;
  /** Optional originating backlog scanner/source for causal tracing. */
  workSource?: WorkSource;
  /**
   * V3.11: the active harness's per-lane effort / sampling for a STANDING
   * fleet dispatch (loop.ts reads it from the tick's `dispatchHarness`).
   * Forwarded to the sandboxed producers, which map it to the engine's own
   * flag / request field (run/harness-dispatch.ts). Absent = the compiled
   * engine defaults, byte-identical argv.
   */
  harness?: import('../run/harness-dispatch.js').DispatchHarness;
}

// ---------------------------------------------------------------------------
// M11: watchable, robust agent foundation (streaming + retry + verify +
// hardened engine delegation + phantom-exec) contract
// ---------------------------------------------------------------------------

/**
 * A single live event emitted during a run so the CLI can stream progress to
 * the user as it happens (model deltas, task lifecycle, tool calls, retries,
 * verification, free-form logs) instead of only printing at the end.
 *
 * METADATA + USER-FACING TEXT ONLY - never carries secret values.
 */
export interface RunStreamEvent {
  /** What kind of event this is. */
  kind: 'task-start' | 'model-delta' | 'tool-call' | 'task-done' | 'retry' | 'verify' | 'log';
  /** Id of the task this event belongs to, when applicable. */
  taskId?: string;
  /** Human-readable / model-delta text payload, when applicable. */
  text?: string;
  /** Structured payload (e.g. tool args, verdict, usage), when applicable. */
  data?: unknown;
  /** ISO timestamp the event was emitted. */
  ts: string;
}

/** Bounded retry policy for a single task. Caps attempts and backoff base. */
export interface RetryPolicy {
  /** Maximum number of attempts (>=1; total tries including the first). */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff between attempts. */
  baseDelayMs: number;
}

/** Verdict from verifying that a task result plausibly satisfies its goal. */
export interface VerifyVerdict {
  /** Whether the result is judged to satisfy the task goal. */
  ok: boolean;
  /** One-line human-readable reason for the verdict. */
  reason: string;
  /** How the verdict was reached. */
  method: 'heuristic' | 'model' | 'command';
}

/** M32: a percentile triple used by RunEstimate. */
export interface PercentileTriple {
  p25: number;
  median: number;
  p75: number;
}

/**
 * M32: pre-flight cost estimate for a run/swarm, derived from persisted
 * history (read-only, never throws - zeroed with confidence 'low' when no
 * history exists). Produced by core/observability/estimate.ts.
 */
export interface RunEstimate {
  kind: 'run' | 'swarm';
  goal: string;
  /** How many history samples informed the estimate. */
  sampleSize: number;
  /** low (<3 samples) · medium (<10) · high (≥10). */
  confidence: 'low' | 'medium' | 'high';
  tokens: PercentileTriple;
  steps: PercentileTriple;
  estCostUsd: PercentileTriple;
  /** Reference cloud cost of the median token volume (context for local $0). */
  wouldBeCloudUsd: number;
  durationMs: PercentileTriple;
  /** True when the requested budget capped the percentiles. */
  budgetClamped: boolean;
  generatedAt: string;
}
