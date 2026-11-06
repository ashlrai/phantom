/** Shared routing contracts. Public entry point: ../types.ts. */

// ---------------------------------------------------------------------------
// M15: cost-optimal, local-first model routing. A per-task router picks the
// cheapest viable provider+model (LOCAL by default); cloud is reachable ONLY
// via --allow-cloud + a present API key + an escalation reason. Cost is
// attributed per provider (local=$0), with a "would-have-been-cloud"
// comparison and a simple monthly forecast. `ashlr models` lists/manages
// local models (opt-in pull/start only). NEVER auto-downloads or auto-spends.
// ---------------------------------------------------------------------------

/** Whether a routed model runs LOCALLY (Ollama/LM Studio) or in the CLOUD. */
export type ModelTier = 'local' | 'cloud';

/** The router's decision for a single task attempt: which provider+model + why. */
export interface RouteDecision {
  /** Provider id the task should run on (e.g. 'ollama', 'lmstudio', 'anthropic'). */
  provider: string;
  /** Concrete model id/name to use on that provider. */
  model: string;
  /** Whether this route is local-first ($0) or an escalated cloud route. */
  tier: ModelTier;
  /** One-line human-readable explanation of why this route was chosen. */
  reason: string;
}

/** A single per-task routing rule: match a goal/task to a preferred model. */
export interface RoutingRule {
  /** Match expression against the task goal (substring/keyword/kind label). */
  match: string;
  /** Preferred model id/name when the rule matches. */
  model: string;
}

/** Why a task escalated (or 'none' when it is a normal first-attempt route). */
export type EscalationReason = 'task-failed' | 'verify-failed' | 'latency' | 'none';

/** A single local model discovered on Ollama or LM Studio. */
export interface LocalModelInfo {
  /** Which local provider exposes this model. */
  provider: 'ollama' | 'lmstudio';
  /** Model name/id as reported by the provider's /api/tags (or equivalent). */
  name: string;
  /** Optional human-readable size label (e.g. '4.7 GB'), when available. */
  sizeLabel?: string;
  /** Whether this is the active/default model for its provider. */
  active: boolean;
}
