/** Shared observability contracts. Public entry point: ../types.ts. */
import type { RunTokenEvidence } from './run.js';

// ---------------------------------------------------------------------------
// M5: local-first observability (cost / tokens / activity) contract
// ---------------------------------------------------------------------------

/**
 * One normalized usage data point. METADATA ONLY - never carries message
 * content. Sourced from Claude Code transcripts ('claude') or local agent
 * runs ('run').
 */
export interface UsageEvent {
  tokenEvidence?: RunTokenEvidence;
  /** ISO timestamp of the event. */
  ts: string;
  /** Absolute project path this usage belongs to, or null if unknown. */
  project: string | null;
  /** Model id that produced the usage. */
  model: string;
  /** Where the event came from. */
  source: "claude" | "run";
  /** Prompt/input tokens. */
  tokensIn: number;
  /** Completion/output tokens. */
  tokensOut: number;
  /** Cache-read input tokens (0 when unavailable). */
  cacheRead: number;
  /** Cache-creation (write) input tokens (0 when unavailable). */
  cacheWrite: number;
}

/** Per-project activity roll-up within a window. */
export interface ProjectActivity {
  tokenEvidence?: RunTokenEvidence;
  /** Absolute project path (or label). */
  project: string;
  /** Number of distinct sessions attributed to the project. */
  sessions: number;
  /** Number of git commits in the window. */
  commits: number;
  /** Total input tokens. */
  tokensIn: number;
  /** Total output tokens. */
  tokensOut: number;
  /** Estimated USD cost. */
  estCostUsd: number;
  /** ISO timestamp of the most recent activity, or null. */
  lastActive: string | null;
}

/** Per-day usage roll-up within a window. */
export interface DailyUsage {
  tokenEvidence?: RunTokenEvidence;
  /** Calendar day (YYYY-MM-DD). */
  day: string;
  /** Total input tokens for the day. */
  tokensIn: number;
  /** Total output tokens for the day. */
  tokensOut: number;
  /** Estimated USD cost for the day. */
  estCostUsd: number;
  /** Number of sessions active that day. */
  sessions: number;
  /** M246: Cache-read tokens for the day (0 when unavailable). */
  cacheRead?: number;
  /** M246: Cache-creation (write) tokens for the day (0 when unavailable). */
  cacheWrite?: number;
  /** M246: Cache hit rate = cacheRead / (tokensIn + cacheRead). 0 on div-by-zero. */
  cacheHitRate?: number;
}

/** Per-model usage roll-up within a window. */
export interface ModelUsage {
  tokenEvidence?: RunTokenEvidence;
  /** Model id. */
  model: string;
  /** Total input tokens. */
  tokensIn: number;
  /** Total output tokens. */
  tokensOut: number;
  /** Estimated USD cost. */
  estCostUsd: number;
  /** Number of calls attributed to the model. */
  calls: number;
  /** M246: Cache-read tokens (0 when unavailable). */
  cacheRead?: number;
  /** M246: Cache-creation (write) tokens (0 when unavailable). */
  cacheWrite?: number;
  /** M246: Cache hit rate = cacheRead / (tokensIn + cacheRead). 0 on div-by-zero. */
  cacheHitRate?: number;
}

/** Budget evaluation for a spend/token cap over a window. */
export interface BudgetAlert {
  /** ok (under), warn (near cap), or over (exceeded). */
  level: "ok" | "warn" | "over";
  /** Window the alert applies to (e.g. '7d'). */
  window: string;
  /** USD spent in the window. */
  spentUsd: number;
  /** Configured USD cap, or null if none set. */
  capUsd: number | null;
  /** Tokens (in + out) spent in the window. */
  spentTokens: number;
  /** Configured token cap, or null if none set. */
  capTokens: number | null;
  /** Human-readable status message. */
  message: string;
}

/** The full observability roll-up for a window. */
export interface ActivityRollup {
  /** Independent hop-ledger productivity; never combined with transcript totals. */
  hopEfficiency?: import('../observability/hop-events.js').HopRollup;
  /** Window label (e.g. '1d' | '7d' | '30d'). */
  window: string;
  /** ISO timestamp marking the start of the window. */
  since: string;
  /** Window totals across all projects/models. */
  totals: {
    tokenEvidence?: RunTokenEvidence;
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    sessions: number;
    commits: number;
  };
  /** Per-project breakdown, sorted by activity. */
  byProject: ProjectActivity[];
  /** Per-day breakdown, ascending by day. */
  byDay: DailyUsage[];
  /** Per-model breakdown, sorted by cost/tokens. */
  byModel: ModelUsage[];
  /** Budget evaluation for the window. */
  budget: BudgetAlert;
}

/** Cost attribution + forward forecast for a recent usage window (M15). */
export interface CostForecast {
  /** Window label the forecast is built from (e.g. '7d' | '30d'). */
  window: string;
  /** Actual USD spent in the window (local providers contribute $0). */
  spentUsd: number;
  /**
   * Estimated USD that the SAME local tokens WOULD have cost on cloud - the
   * savings from staying local. Clearly an estimate, never fabricated precision.
   */
  localSavingsUsd: number;
  /** Simple projected monthly USD spend extrapolated from the window's rate. */
  projectedMonthlyUsd: number;
}

/**
 * M19: one GenAI span derived from a completed run/swarm task. METADATA ONLY -
 * carries token counts, cost, ids, status, and timing; NEVER prompts,
 * completions, tool args, file contents, or secrets. The single normalized
 * shape that both the OTLP emitter and the local-file sink consume.
 */
export interface GenAiSpan {
  tokenEvidence?: RunTokenEvidence;
  /** Span name (e.g. the operation/task identifier - metadata, not content). */
  name: string;
  /** Owning run or swarm id this span belongs to. */
  runId: string;
  /** Model id used (maps to gen_ai.request.model). */
  model: string;
  /** Provider id used (maps to gen_ai.system). */
  provider: string;
  /** Routing tier (e.g. 'local' | 'cloud' or model-tier label). */
  tier: string;
  /** Accounted input tokens; only reported provenance maps to gen_ai.usage.input_tokens. */
  tokensIn: number;
  /** Accounted output tokens; only reported provenance maps to gen_ai.usage.output_tokens. */
  tokensOut: number;
  /** Estimated USD cost for this span. */
  estCostUsd: number;
  /** Terminal status string (e.g. 'done' | 'failed' | 'aborted'). */
  status: string;
  /** ISO start timestamp. */
  startTs: string;
  /** ISO end timestamp. */
  endTs: string;
}

/**
 * M19: result of emitting spans through a TelemetrySink. Best-effort -
 * `ok:false` records a failure detail (logged to stderr only) and is NEVER
 * allowed to block or throw out of a run/swarm.
 */
export interface TelemetryEmitResult {
  /** Which sink handled the emit. */
  sink: "local" | "otlp";
  /** Whether the emit succeeded (best-effort; failures never block). */
  ok: boolean;
  /** Human-readable detail - NEVER contains the PAT, prompts, or content. */
  detail: string;
}
