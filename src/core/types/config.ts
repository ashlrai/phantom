/** Shared config contracts. Public entry point: ../types.ts. */
import type { GoalPreferenceConfig } from '../goals/preferences.js';
import type { LeaderPreferenceConfig } from '../vision/leader-preferences.js';
import type { DaemonConfig } from './daemon.js';
import type { BestOfNCandidateSpec, EngineId, EngineSpec, EngineTier, ExecutionIdentityConfigV1 } from './engines.js';
import type { NotifyTarget } from './integrations.js';
import type { AutoMergeTrustBasis, ProtectedRemoteRepositoryExpectation, ProtectedRemoteRequiredCheckExpectation } from './proposals.js';
import type { RoutingRule } from './routing.js';
import type { TidyRule } from './workspace.js';

/** Persisted configuration for the hub. Lives at ~/.ashlr/config.json. */
export interface AshlrConfig {
  /** Optional agent graph inspection root. Explicit existing canonical private directory;
   * absent disables firm MCP resources. Reading never enrolls, executes, or creates keys.
   */
  firm?: { graphRoot: string };
  /** Schema/config version for forward migration. */
  version: number;
  /** Absolute roots to scan (typically the Desktop and github/). */
  roots: string[];
  /** Preferred editor for deep links. */
  editor: 'cursor' | 'vscode';
  /** Markdown opener. Default `ashlr-md` (when installed, else editor); `editor` opts out. */
  markdownOpener?: 'ashlr-md' | 'editor';
  /** Days without modification before an item is considered stale/inactive. */
  staleDays: number;
  /** Map of category name -> absolute folder path (e.g. "dev-tools" -> ".../github/dev-tools"). */
  categories: Record<string, string>;
  /** Ordered tidy rules applied to loose top-level files. */
  tidyRules: TidyRule[];
  /** Absolute paths or basenames that must never be moved/tidied. */
  keepers: string[];
  /** Local + remote model configuration and provider preference order. */
  models: {
    lmstudio: string;
    ollama: string;
    providerChain: string[];
    /**
     * Optional per-task routing rules (M15). Each rule maps a goal/task match
     * to a preferred model. First matching rule wins; falls back to local-first
     * chain selection when none match. Never forces a cloud provider on its own.
     */
    routing?: RoutingRule[];
    /**
     * Optional auto-escalation policy (M15). When `onFailure` is true, a LOCAL
     * task that fails/verify-fails (or exceeds `latencyMs`) MAY escalate to a
     * cloud provider for one routed retry - but ONLY when --allow-cloud is set
     * and a cloud key is present. Never enables silent cloud spend on its own.
     */
    escalate?: { onFailure: boolean; latencyMs?: number };
    /**
     * M41: enable the model-adaptive prompt suite (Fable-5-grade layered
     * system prompts + per-model profiles for verbosity / step-cap /
     * temperature). Default OFF - when absent/false the harness uses its
     * legacy prompts and step cap unchanged. Overridable per-process via the
     * ASHLR_ADAPTIVE_PROMPTS env var.
     */
    adaptivePrompts?: boolean;
    /**
     * M41: optional per-profile overrides keyed by profile id
     * ('coder' | 'general' | 'small' | 'default'). Shallow-merged onto the
     * built-in ModelProfile. Power-user knob; absent by default.
     */
    profiles?: Record<string, Partial<import('../run/model-profile.js').ModelProfile>>;
  };
  /** Telemetry hooks (e.g. Pulse) + local budget caps. All fields optional. */
  telemetry: {
    pulse?: string;
    /** Optional spend cap (USD) for the budget window; alerts when over/near. */
    budgetUsd?: number;
    /** Optional token cap (in + out) for the budget window. */
    budgetTokens?: number;
    /** Window the budget caps apply to (default '7d' when caps are set). */
    budgetWindow?: "1d" | "7d" | "30d";
    /**
     * M19 spend governance action when the period spend exceeds the cap.
     * 'warn' (default): advisory only - print a prominent warning, never block.
     * 'block': additionally require an explicit --over-budget flag to proceed.
     * Governance NEVER silently blocks; the per-run hard budget remains the
     * only hard ceiling.
     */
    govAction?: "warn" | "block";
  };
  /** Map of integration name -> resolved executable path (entire, aw, claude, ...). */
  tools: Record<string, string>;
  /** Optional Phantom secrets integration toggle. */
  phantom?: {
    enabled: boolean;
    /** Count-only `phantom agent report --json` rollup. Default off. */
    agentReportRollup?: {
      enabled?: boolean;
      timeoutMs?: number;
      cacheTtlMs?: number;
    };
  };

  /**
   * Locus identity-plane settings for hub fleet / pre-mutate gates.
   * DEFAULT ABSENT → enforce mode is off (monorepo-safe). Never always-on.
   *
   * Resolution order (see `resolveLocusEnforceMode`):
   *   1. env `LOCUS_ENFORCE` when set (wins over config, including =off)
   *   2. `locus.enforce` when set explicitly
   *   3. `locus.firm === true` → enforce (production fleet profile)
   *   4. off
   *
   * Firm agencies (always-on identity gates) typically set either:
   *   "locus": { "firm": true }
   * or the explicit mode:
   *   "locus": { "enforce": "enforce" }
   * Soft roll-out:
   *   "locus": { "enforce": "warn" }
   * Local override without editing config:
   *   LOCUS_ENFORCE=off
   *
   * CLI: `ashlr config set locus.firm true`
   * Do NOT set firm true as a monorepo default.
   */
  locus?: {
    /**
     * Pre-mutate / CI session isolation mode.
     * - off: no CLI probe (default when unset)
     * - warn: log blockers, allow dispatch
     * - enforce: fail closed when fleet gate blocks
     * Explicit value beats `firm` profile.
     */
    enforce?: 'off' | 'warn' | 'enforce';
    /**
     * Firm profile for production fleets. When true and `enforce` is unset
     * (and env LOCUS_ENFORCE is unset), mode resolves to enforce.
     * Default false/absent - monorepo stays off.
     */
    firm?: boolean;
  };
  /**
   * Shared-memory / genome settings (M7). Controls recall limits and whether
   * the orchestrator injects recall hits into sub-agent prompts.
   */
  genome?: {
    /** Max number of recall hits returned/injected (default 5). */
    maxRecall: number;
    /** Whether `ashlr run` injects top-k recall into sub-agent prompts (default true). */
    injectOnRun: boolean;
    /**
     * Whether a completed run/swarm auto-captures a summary GenomeEntry (M16).
     * Default true. Summary/metadata only; fire-and-forget; opt out per-call
     * via --no-capture. Never blocks/slows a run.
     */
    autoCapture?: boolean;
    /**
     * Whether `runGoal` synthesizes + injects a bounded playbook from past
     * similar entries into planning context (M16). Default true.
     */
    playbookOnRun?: boolean;
  };
  /**
   * Optional outward notification targets (M18). When a webhook is set, a
   * concise run/swarm COMPLETION summary MAY be posted to it (no secrets).
   * Entirely opt-in: a no-op when unset - notify() never posts without one.
   */
  notify?: NotifyTarget;
  /**
   * M45: multi-backend engine fleet (v4 Foundry). ENTIRELY OPT-IN - when absent,
   * behavior is unchanged (builtin only; external engines run raw as today).
   * When present, external engines run SANDBOXED with diff capture and the fleet
   * may route work across the allowed backends.
   */
  foundry?: {
    /**
     * Persist raw run output under ~/.ashlr/run-streams for local SSE replay.
     * Privacy-sensitive and DEFAULT OFF: only the exact value true enables it.
     * Live in-memory CLI streaming is unaffected.
     */
    runOutputPersistence?: {
      enabled?: boolean;
    };
    /**
     * Execution Identity V1: default-off, shadow-only account/runtime capacity
     * projection. Private locators are consumed only by the internal fabric
     * module; V1 assignments never reach the live dispatcher.
     */
    executionIdentityV1?: ExecutionIdentityConfigV1;
    /** Backends the fleet may use. Absent ⇒ ['builtin'] only. */
    allowedBackends?: EngineId[];
    /**
     * LOCAL-ONLY: make cloud engines UNREACHABLE, not merely deprioritised.
     *
     * This is a refusal, not a preference. While it is true, every dispatch
     * path (`getActiveClient`, `buildOpenAICompatibleClient`, `spawnEngine`,
     * and both sandboxed runners) refuses any engine whose RESOLVED ENDPOINT
     * is not loopback, with a named reason - so an accidental frontier
     * dispatch cannot spend money the operator has deliberately forgone.
     *
     * Locality is decided by endpoint, not by tier: `local-coder` and `nim`
     * are both tier 'mid', but one is free and one bills NVIDIA. An engine
     * whose locality cannot be determined is treated as CLOUD.
     *
     * Also honoured at `cfg.models.localOnly`, and forced on for the process
     * by `ASHLR_LOCAL_ONLY`. See src/core/policy/local-only.ts and
     * docs/LOCAL-FLEET.md ("What 'local only' has to mean").
     */
    localOnly?: boolean;
    /**
     * M308: executable autonomy control loop. When Foundry is configured, each
     * daemon tick consumes the resource-aware direction report before dispatching:
     * pause/verify-only modes skip new proposal generation, local-only constrains
     * routing to local-capable engines, and backlog-build keeps normal behavior.
     * DEFAULT true when `foundry` is present; set false for advisory-only mode.
     */
    autonomyControlLoop?: boolean;
    /**
     * Reader-first migration gate for objective-scoped repair handoff schema v2.
     * Default false: writers keep emitting rollback-compatible v1 rows while
     * every deployed reader learns the isolated v2 sidecar format first.
     */
    repairHandoffV2Write?: boolean;
    /** CLI-issued identity for the current v2 writer activation epoch. */
    repairHandoffV2Activation?: {
      /** Fresh UUID minted whenever config set transitions the writer from disabled to enabled. */
      id: string;
      /** Canonical ISO timestamp recorded with the activation identity. */
      activatedAt: string;
    };
    /** Per-backend preferred model id (keyed by EngineId). */
    models?: Partial<Record<EngineId, string>>;
    /**
     * M320: Claude 5 generation rollout (Sonnet 5 workhorse + Fable 5
     * judge/strategist). Absent ⇒ enabled.
     */
    claude5?: {
      /**
       * Master switch. false ⇒ claude:sonnet-5 / claude:fable-5 are excluded
       * from routing and all model defaults revert to the pre-M320 values
       * (byte-identical rollback). Default true.
       */
      enabled?: boolean;
      /**
       * Fable 5 (claude-fable-5, Mythos-class above Opus) as the default
       * judge + strategist model, with automatic fallback to claude-opus-4-8
       * when a Fable call fails, is refused, or returns empty. false ⇒
       * judge/strategist defaults stay claude-opus-4-8. Default true.
       */
      fable?: boolean;
    };
    /**
     * M323: model-granular cost-aware learned routing. DEFAULT OFF. When
     * enabled, routeTask prefers the CHEAPEST catalog model whose learned
     * producer ship-rate (authenticated realized merges joined to signed
     * proposal provenance) clears minShipRate with enough samples; it falls back to
     * the static policy pick otherwise - cold start / thin samples are
     * byte-identical to flag-off. Learned decisions never auto-apply.
     *
     * Deliberately NOT under foundry.intelligence - that block's PRESENCE
     * activates the M53 anomaly/budget nudges, which this flag must not
     * silently switch on.
     */
    modelGranularRouting?: {
      /** Master switch. Default false. */
      enabled?: boolean;
      /** Minimum learned ship-rate for the cost-aware pick (0..1, default 0.6). */
      minShipRate?: number;
    };
    /**
     * M331: verify-to-green - bounded engine repair loop before a proposal is
     * filed. DEFAULT OFF. When enabled and the M275 completeness gate fails a
     * cli-agent run, the SAME engine is re-invoked inside the SAME confined
     * worktree (identical contained env + OS sandbox launcher) with the
     * verification failure tail, up to maxIterations times; the diff is only
     * filed once the gate passes, re-captured and re-signed against the
     * repaired worktree. Flag-off ⇒ byte-identical single-shot gate. The
     * api-model path is out of scope (agent-loop patch application).
     */
    /**
     * M170/M333: best-of-N candidate generation. N > 1 ⇒ the dispatch loop
     * generates N candidates and the critic picks the winner. Formalized here
     * in M333 (read via `as any` since M170). Default 1 (single dispatch).
     */
    bestOfN?: number;
    /**
     * M333: per-candidate engine/model specs for multi-model best-of-N -
     * e.g. [{engine:'claude', model:'claude-sonnet-5'}, {engine:'codex'},
     * {engine:'local-coder'}]. Candidate i runs on specs[i % specs.length].
     * Invalid entries or entries outside allowedBackends refuse the entire
     * explicit race before dispatch. Absent ⇒
     * single-engine stochastic resampling (M170 behavior). Trust is
     * unchanged: a winning mid/local candidate keeps its tier tag and can
     * never gain merge authority.
     */
    bestOfNCandidates?: BestOfNCandidateSpec[];
    /**
     * M333: fan out only for work items whose score ≥ this threshold; below
     * it, single dispatch. Absent ⇒ every item fans out when bestOfN > 1
     * (M170 behavior). Cost guard: full candidate spend (billableCostUsd,
     * subscription-aware) counts against the tick budget - the pre-M333
     * accounting counted only the winner.
     */
    bestOfNMinItemScore?: number;
    /**
     * M332: outcome watcher - observation-only maintenance pass recording
     * real-world reverts and near-term follow-up fixes in signed metadata
     * ledgers. It never rewrites judge labels or skill lifecycle state.
     * Internally throttled after complete scans. DEFAULT ON; false disables.
     */
    outcomeWatcher?: boolean;
    verifyToGreen?: {
      /** Master switch. Default false. */
      enabled?: boolean;
      /** Max repair iterations (clamped 1–5, default 3). */
      maxIterations?: number;
      /** Per repair-run timeout in ms (default 180_000). */
      perRunTimeoutMs?: number;
      /** Verification-failure tail bytes fed back to the engine (default 8192). */
      failureTailBytes?: number;
    };
    /** Run external engines inside a sandbox with diff capture (default true when foundry set). */
    sandboxExternal?: boolean;
    /** Hard wall-clock per external run (ms). Default 20 min. */
    timeoutMs?: number;
    /**
     * M275: completeness + self-verify gate. DEFAULT true (on). When true, a
     * sandboxed engine run's diff must pass typecheck + (if cheap) tests in the
     * sandbox worktree before being filed as a proposal. Partial/timed-out runs
     * and dep-changes without lockfile updates are also suppressed. Set false
     * for pre-M275 byte-identical behavior (gate entirely skipped).
     */
    completenessGate?: boolean;
    /**
     * Allowlist for the (later) merge-authority gate: a proposal may auto-apply
     * to main only if its {engine,model} matches an entry here. Defined now,
     * enforced in a later milestone.
     */
    mergeAuthority?: Array<{ engine: EngineId; model: string }>;
    /**
     * M46: per-backend rate limits for subscription backends (flat-fee, rate-
     * limited - not token-billed). Keyed by EngineId. `window` is a label like
     * '1m'|'5m'|'1h'|'1d'; `max` is the max dispatches per rolling window.
     * Absent ⇒ unlimited. Used by the fleet scheduler (M46/M48).
     */
    limits?: Partial<Record<EngineId, { window: string; max: number }>>;
    /**
     * M80: subscription-window throttle. A subscription-billed engine is
     * skipped for the rest of its window once a KNOWN window reading reaches
     * this percentage. Unknown usage (e.g. Claude, which has no local signal)
     * is never throttled by it.
     *
     * Valid range 1–100; absent ⇒ 90. Read ONLY through
     * `resolveSubscriptionMaxPercent()` in `core/config.ts` - that helper owns
     * the clamp so the daemon loop, the fleet router, and the fabric gateway
     * cannot drift apart. Before V2 this key was read through an untyped cast
     * in five places; this declaration is its typed home.
     */
    subscriptionMaxPercent?: number;
    /**
     * M50 (v5): declarative engine roster. Each entry overrides a builtin
     * engine spec or adds a new backend (cli-agent or OpenAI-compatible
     * api-model), keyed by engine id. Merged over BUILTIN_ENGINE_REGISTRY by
     * `resolveEngineRegistry`. Absent ⇒ exactly the builtin roster. This is the
     * config-only path to adding a backend - no code branch.
     */
    engines?: Record<string, EngineSpec>;
    /**
     * M195: NVIDIA NIM backend config (OpenAI-compatible cloud inference).
     *
     * Lets the 'nim' engine run a frontier-class open model - e.g. Kimi K2
     * (strong at coding) - as additional frontier-tier ammo. ENTIRELY OPT-IN:
     * the 'nim' engine is only active when ALL of the following hold:
     *   1. 'nim' is listed in cfg.foundry.allowedBackends, AND
     *   2. this `nim` block supplies promotion/model overrides when needed, AND
     *   3. the existing environment API key resolves (NVIDIA_NIM_API_KEY).
     * Absent ⇒ zero effect; the fleet behaves exactly as before.
     *
     * The API key is NEVER stored here and NEVER logged - only the env var NAME
     * holding it is referenced. The key is resolved from the existing environment
     * at dispatch; in-process vault transport is not qualified.
     */
    nim?: {
      /**
       * OpenAI-compatible base URL. Default 'https://integrate.api.nvidia.com/v1'.
       * Verified live (2026-06): NIM exposes the chat completions endpoint at
       * https://integrate.api.nvidia.com. Override env: NVIDIA_NIM_BASE_URL.
       */
      baseUrl?: string;
      /**
       * Model id to run. Default 'moonshotai/kimi-k2.6' (Kimi K2 - strong
       * coding/agentic frontier-class open model, verified live on the NIM
       * catalog 2026-06). Any NIM-hosted OpenAI-compat model id is accepted.
       */
      model?: string;
      /**
       * Env var NAME holding the bearer API key. Default 'NVIDIA_NIM_API_KEY'.
       * The VALUE is never read into config or logs - only resolved at dispatch.
       */
      apiKeyEnv?: string;
      /**
       * Trust tier for routing. Default 'frontier' so NIM/Kimi-K2 is usable as
       * frontier-tier ammo (branch-eligible AND merge-authority-eligible like
       * claude/codex). Set 'mid' to keep it branch-only (no main-merge authority).
       * This is the single switch that promotes 'nim' into the frontier rotation.
       */
      tier?: EngineTier;
      /**
       * Explicit concurrent request cap used by resource-aware concurrent
       * dispatch. NIM has no proactive quota signal, so this cap is the
       * operator's local governor; 429/backoff signals still win.
       */
      maxConcurrent?: number;
      /** Optional cost estimate for resource/status displays. */
      costPerMTokenOut?: number;
    };
    /**
     * Kimi/Moonshot resource hints. Kimi is normally defined via
     * `foundry.engines.kimi`; this block only supplies explicit resource caps
     * to the ResourceMonitor and concurrent dispatcher.
     */
    kimi?: {
      maxConcurrent?: number;
      costPerMTokenOut?: number;
      /**
       * M270: high-level convenience override that promotes the 'kimi' engine
       * spec's tier (engine-registry.ts:405 applyKimiConfig - e.g.
       * `foundry.kimi = { tier: 'frontier' }` grants WORK-ASSIGNMENT frontier
       * eligibility without touching the builtin registry). Previously read
       * only via an untyped `(cfg?.foundry as Record<string, unknown>)?.['kimi']`
       * cast; live in ~/.ashlr/config.json (tier: 'frontier') as of this audit.
       */
      tier?: EngineTier;
    };
    /**
     * M248: guarantee fleet sandboxed engines inherit ashlr-plugin MCP tools.
     * When true (DEFAULT), writes a minimal fleet-owned MCP sidecar into the ephemeral
     * worktree before spawning and adds `--mcp-config <path>
     * --strict-mcp-config` to the claude argv so ashlr__ compression tools are
     * available without inheriting global MCP servers into daemon runs.
     * Guarded by `which ashlr` - if the plugin binary is absent (e.g. CI),
     * this flag has zero effect and the run proceeds exactly as before.
     * Set false to disable for debugging or environments where the plugin
     * conflicts. Absent ⇒ true (on).
     */
    fleetMcp?: boolean;
    /**
     * M124: backlog value filter. Items with value < minItemValue are dropped
     * before the daemon selects work. Default 2 (drops value-1 trivia).
     * Set to 1 to disable the gate; set to 3+ to raise the bar further.
     */
    minItemValue?: number;
    /**
     * M136: TODO/FIXME marker scanner toggle. DEFAULT false - the fleet works
     * substantive sources (issues, lint, security, deps, self-improve, hygiene)
     * instead of drowning in bare marker noise. Set true to re-enable the
     * scanner; even when true, vendored/third-party directories and
     * non-first-party source paths are never scanned.
     */
    scanTodos?: boolean;
    /**
     * M160: dependency-bump scanner toggle. DEFAULT false - dep-bumps are low-
     * value volume work. Set true to re-enable npm-audit vulnerability scanning.
     * Mechanical outdated-package bumps remain separately gated by
     * scanDependencyBumps and are still skipped unless the repo has a lockfile
     * and test script. Major-version bumps are always skipped (M159 invariant).
     * Mirrors the M136 scanTodos pattern.
     */
    scanDeps?: boolean;
    /**
     * M271: mechanical npm-outdated package bump scanner toggle. DEFAULT false.
     * Requires scanDeps=true as well. This keeps unjustified package.json-only
     * maintenance out of the frontier/judge loop unless explicitly requested.
     */
    scanDependencyBumps?: boolean;
    /**
     * M160: lint-error scanner toggle. DEFAULT false - cached-lint-report items
     * rarely produce shippable diffs from the fleet. Set true to surface fixable
     * lint errors from a pre-existing cached report file.
     */
    scanLint?: boolean;
    /**
     * M160: repo-hygiene (missing README/LICENSE/CONTRIBUTING) scanner toggle.
     * DEFAULT false - hygiene items (scanDocs) are trivial volume that a judge
     * rates "review". Set true to surface missing-doc items.
     */
    scanHygiene?: boolean;
    /**
     * M222: goal→milestones auto-planning. DEFAULT true (on). When true,
     * scanGoals lazily calls the FRONTIER strategist to decompose active goals
     * that have zero milestones into 3-6 concrete, independently-shippable
     * milestones before emitting work items. Each expansion runs once per goal
     * per daemon tick (in-process cache). Set false to restore pre-M222
     * behavior: goals without milestones are silently skipped (emit nothing).
     */
    goalPlanning?: boolean;
    /**
     * Goal focus mode. DEFAULT true. When at least goalFocusActiveThreshold
     * repo-bound active goals already have pending/in-progress milestones, the
     * fleet defers new planning-goal expansion and generative invention so it
     * can close existing work before widening the queue. Set false to restore
     * broader exploration.
     */
    goalFocusMode?: boolean;
    /** Active actionable-goal threshold for goalFocusMode. Default 4. */
    goalFocusActiveThreshold?: number;
    /** Operator goal preferences; absent fields preserve legacy defaults, null removes that preference. */
    goalPreferences?: GoalPreferenceConfig;
    /** Operator daily Leader run preferences; null removes only the selected business ceiling. */
    leaderPreferences?: LeaderPreferenceConfig;
    /**
     * M167: headless browser verification of web-app renders after a diff.
     * DEFAULT false (opt-in - doubles verify time for UI repos). When true,
     * `verifyInBrowser` starts the dev server, navigates a headless browser,
     * and captures renderOk + console errors as additional evidence for the
     * judge. Degrades gracefully when no headless browser driver is present.
     * Zero runtime deps - shells out to playwright (if installed) or system
     * Chrome/Chromium; never blocks when neither is available.
     */
    browserVerify?: boolean;
    /**
     * Pluggable visual grounding layer for screenshot/document perception.
     *
     * DEFAULT false. This is intentionally separate from `src/core/vision`,
     * which stores the strategic north-star vision. Visual grounding means
     * pixel-space localization: image + natural-language query -> normalized
     * boxes/points that can become verification evidence or proposed UI actions.
     *
     * Providers that upload local screenshots to an HTTP endpoint require an
     * explicit config opt-in. NVIDIA LocateAnything-3B is supported as a local
     * research worker shape, but its released weights are non-commercial; set
     * `licenseAccepted:true` only after the operator has reviewed the model
     * terms for the intended use.
     */
    visualGrounding?: {
      /** Master switch. Absent/false means no image reads or provider calls. */
      enabled?: boolean;
      /** Provider implementation. Default 'locateanything-http'. */
      provider?: 'locateanything-http' | 'generic-openai-vision';
      /**
       * Base URL or full chat completions URL for an OpenAI-compatible worker.
       * Loopback endpoints are allowed by default; remote endpoints also require
       * allowRemoteEndpoint=true because screenshots may contain sensitive data.
       */
      endpoint?: string;
      /** Model id sent to the provider. Default depends on provider. */
      model?: string;
      /**
       * Optional default query used by browser verification screenshot grounding.
       * When omitted, browser verification never calls a visual grounding model.
       */
      query?: string;
      /** Env var NAME containing a bearer token for the provider. */
      apiKeyEnv?: string;
      /** Hard timeout for one grounding call. Default 30000ms. */
      timeoutMs?: number;
      /** Max local image size to upload/read. Default 8 MiB. */
      maxImageBytes?: number;
      /** Required for LocateAnything because released weights are non-commercial. */
      licenseAccepted?: boolean;
      /** Required before sending screenshots to non-loopback endpoints. */
      allowRemoteEndpoint?: boolean;
    };
    /**
     * M168 compatibility flag: apply the existing result scrubber to requested
     * environment keys in withPhantomSecrets and enable names-only vault
     * inspection. Default false. No automatic vault value extraction; arbitrary
     * callback logs/errors are not confined by this helper. Child proxy execution
     * is separately managed by engines.ts.
     */
    usePhantom?: boolean;
    /**
     * M158: destructive-diff pre-judge guard. DEFAULT true (safety guard - on by
     * default; set false to disable). When true, proposals whose diff matches a
     * clearly-destructive pattern (wholesale file gutting, package.json dep
     * destruction, JSON key collision, critical file deletion) are auto-rejected
     * at intake before reaching the pending queue or frontier judge.
     */
    diffSafety?: boolean;
    /**
     * M183: frontier TASTE critic for best-of-N SELECTION. DEFAULT false (off).
     * When true, best-of-N calls scoreTaste() (Opus) on each test-passing
     * candidate and selects the highest-taste overall score rather than the
     * first that compiles. Tie-broken by the existing correctness critic score.
     * Does NOT add any merge gate - taste only influences selection + curation
     * (the safety floor in automerge-pass.ts is unchanged). Flag off → selection
     * is byte-identical to pre-M183.
     */
    tasteCritic?: boolean;
    /**
     * M128: intelligent model-granular routing policy.
     *  'balanced' (DEFAULT) - free-local for bulk, reserve strong models for
     *                          hard tasks, cheap-cloud for medium. Roughly
     *                          equivalent to pre-M128 tier behavior + model
     *                          granularity.
     *  'cost'     - default to free-local + cheapest model that meets the
     *               difficulty bar; escalate to cloud only when local is
     *               unavailable or task is hard.
     *  'quality'  - best model for every task regardless of cost; frontier
     *               models for all non-trivial work.
     * Absent ⇒ 'balanced'.
     */
    routingPolicy?: 'balanced' | 'cost' | 'quality';
    /**
     * M240: learned-routing - bias engine/model selection using historical
     * judge outcomes from the decisions ledger.
     *
     * When explicitly true, routeTask computes a per-(engine, model, taskClass)
     * ship-rate from the decisions ledger and uses it as a tie-breaker: engines
     * with a higher ship-rate for the current task's source-class are tried
     * first. Requires a minimum sample floor (≥5 judged events per key) before
     * any bias is applied - cold-start falls back to static policy unchanged.
     * The bias is a tie-breaker only: hard constraints (capability, tier, quota,
     * allowedBackends, budget) are NEVER bypassed.
     *
     * False or absent preserves exact pre-M240 behavior (byte-identical static
     * routing). Operational steering additionally requires causally
     * identifiable, authenticated assignment evidence.
     */
    learnedRouting?: boolean;
    /**
     * M166: model-racing + distillation dataset. DEFAULT DISABLED (doubles
     * inference cost per raced task - opt-in only for a sampled subset).
     *
     * When enabled, raceTask() runs the SAME work item through both the local
     * engine (qwen3-coder / any api-model) AND a frontier engine (claude/codex),
     * scores each via the frontier judge, determines the winner, and persists
     * the race record to ~/.ashlr/racing/<date>.jsonl - a distillation dataset
     * where the frontier diff is the teacher target for local model improvement.
     *
     * Use racingStats() to observe how far local lags frontier and track closure.
     */
    modelRacing?: {
      /** Enable model racing. Default false. */
      enabled: boolean;
      /**
       * Local engine to race. Defaults to 'local-coder'.
       * Must be an api-model engine (OpenAI-compatible / Ollama).
       */
      localEngine?: string;
      /**
       * Frontier engine to race against. Defaults to 'claude'.
       * Should be a frontier-tier engine in cfg.foundry.allowedBackends.
       */
      frontierEngine?: string;
    };
    /**
     * M53: fleet-intelligence tuning. Absent ⇒ learned routing / budget recovery
     * / anomaly holds are OFF (the daemon routes exactly as M46/M48). All actions
     * stay proposal-only - this only tunes WHICH backend/tier and WHEN to hold.
     */
    intelligence?: {
      /** Anomaly threshold k: a run costing > k × p50 is held + a TuningProposal filed (default 4). */
      anomalyK?: number;
      /** Min verified-success rate below which a class is nudged off frontier (0..1, default 0.5). */
      minFrontierSuccessRate?: number;
      /**
       * Min recent dispatch proposal-yield rate below which same-tier alternates
       * may be preferred (0..1, default 0.2). Uses metadata-only
       * dispatch-production events and never escalates tier.
       */
      minProposalYieldRate?: number;
      /** Window for dispatch-production yield priors in hours (default 24). */
      dispatchYieldWindowHours?: number;
    };
    /**
     * M47: tiered-trust auto-merge to main. DEFAULT DISABLED. When enabled, a
     * proposal may be merged to the default branch ONLY when ALL hold: it is
     * frontier merge-authority (engineTier 'frontier' + {engine,model} ∈
     * mergeAuthority), its risk class is ≤ maxRisk, and full verification passes.
     * Kill-switch and human override always apply; nothing auto-merges by default.
     *
     * M153: trustBasis selects the authority model for Gate 4:
     *   'tier' (DEFAULT, absent ⇒ 'tier') - M51 behavior: proposal.engineTier
     *     MUST be 'frontier' AND {engine,model} ∈ mergeAuthority. Byte-identical
     *     to pre-M153 when absent or set to 'tier'.
     *   'verification' - replaces the frontier-tier requirement with a STRONGER
     *     5-criterion bar (frontier judge 'ship', full suite green, risk/scope
     *     caps, EDV independent confirmation, valid signed provenance). ANY
     *     producer tier (including local qwen3-coder) may merge when the full
     *     bar clears. The JUDGE must be frontier (claude-*); the PRODUCER may
     *     be local. Self-confirmation (local judge) is NEVER allowed in this mode.
     *     The tier/mergeAuthority check is REPLACED (not bypassed) by this bar.
     *     M54 never-weaken + self-target guard + allowSelfMerge parity unchanged.
     *   'evidence' - judge-free deterministic authority: base-bound suite green,
     *     current-diff verification binding, valid provenance, EDV confirmation,
     *     risk/scope caps, no partial capture, and no build/CI/manifest changes.
     */
    /**
     * M214: emit GenAI-OTel spans for fleet events (proposal, merge, judge
     * verdict, tick cost) to the Pulse OTLP ingest so Pulse becomes a live
     * fleet dashboard. DEFAULT false (additive, flag-gated, fire-and-forget).
     * Endpoint: cfg.comms.pulseOtlpUrl → PULSE_OTLP_URL env → cfg.pulse.endpoint.
     */
    pulseEmit?: boolean;
    /**
     * M243: skill-library write-back (positive complement to M235 anti-playbooks).
     * DEFAULT true (on). When true, receipt-qualified realized merge proposals
     * have their workflow recipe distilled and written to the genome hub as a
     * reusable skill (AWM/Voyager: abstracted workflow, NOT raw diff verbatim).
     * Future agent runs receive positive grounding: proven patterns for proven
     * task classes. Set false for exact pre-M243 behavior (byte-identical no-op).
     */
    skillLibrary?: boolean;
    /**
     * M259: max frontier-judge calls per runAutoMergePass tick (default 8).
     * Proposals that exceed the cap are skipped and retried on the next tick.
     * Raise this to drain a backlog faster; lower it to protect inference budget.
     */
    judgePerPass?: number;
    /**
     * M259: auto-archive proposals that accumulate K consecutive non-ship
     * judge verdicts (review/harmful/noise). Default 3. A proposal that reaches
     * this threshold is marked 'rejected' with reason 'auto-archived' - it is
     * no longer re-judged and no longer counts as pending. Strictly additive
     * (only adds a reject path; NEVER weakens the merge gate).
     */
    autoArchiveAfterRejects?: number;
    /**
     * M259: TTL for pending proposals (days). A pending proposal older than
     * this many days is auto-rejected as stale. Default 7. Belt-and-suspenders
     * complement to autoArchiveAfterRejects. Set 0 to disable TTL. Strictly
     * additive (only adds a reject path; NEVER weakens the merge gate).
     */
    proposalTtlDays?: number;
    /**
     * M280: simple-conductor mode. DEFAULT false (off). When true, `ashlr loop`
     * uses the flat-task dispatch loop (runSimpleConductor) instead of the
     * goal-conductor. Tasks are read from ~/.ashlr/tasks.json. Flag off ⇒
     * byte-identical old behavior (runConductor).
     */
    simpleConductor?: boolean;
    /**
     * M300: Resource-aware dispatch. DEFAULT true (on). When true, the simple-
     * conductor checks the resource snapshot before dispatching each task; if the
     * task's engine is exhausted/unreachable it routes to the best available
     * alternative from engineFallbackOrder. Set false for pre-M300 behaviour
     * (always dispatch with task.engine as-is - byte-identical).
     */
    resourceAwareDispatch?: boolean;
    /**
     * M297: bounded retry count for transient external-agent aborts.
     * DEFAULT 2 means one initial attempt plus two retries. Only empty-diff
     * transient aborts are retried; stall/timeouts and partial work are not.
     */
    dispatchRetries?: number;
    /**
     * Test/operator kill flag for sandboxed dispatch. This is only more
     * restrictive than the global ~/.ashlr/KILL switch and never bypasses it.
     */
    killSwitch?: boolean;
    /**
     * M300: Fallback engine preference order when the primary engine is
     * exhausted. Default: ['codex','kimi','nim','local-coder']. The conductor
     * tries each in order and picks the first whose availability is not
     * 'exhausted', 'throttled' or 'unreachable'. With no open candidate it uses
     * a throttled one (original first). When every candidate is exhausted or
     * unreachable the task is deferred unclaimed (no attempt, no sandbox) and
     * reported in SimpleConductorResult.deferred. Unknown availability fails
     * open to the original engine.
     */
    engineFallbackOrder?: string[];
    autoMerge?: {
      enabled: boolean;
      /**
       * M153: trust basis for Gate 4 (default 'tier' = M51 behavior unchanged).
       * See comment above for full semantics.
       */
      trustBasis?: AutoMergeTrustBasis;
      /** Max risk class permitted to auto-merge (default 'low'). */
      maxRisk?: 'low' | 'medium' | 'high';
      /** Optional pass-level manager quality gate. Default false. */
      managerGate?: boolean;
      /** Permit self-target auto-merge after self safety checks. Default false. */
      allowSelfMerge?: boolean;
      /** Max files permitted in an auto-merge diff (default 4, hard maximum 10). */
      maxAutomergeFiles?: number;
      /** Max changed lines permitted in an auto-merge diff (default 150, hard maximum 300). */
      maxAutomergeLines?: number;
      /** Stage/push a reviewed branch and open a protected PR handoff; never merges the hosted PR (default false). */
      pushToRemote?: boolean;
      /**
       * Remote-main policy expectation. This configuration is never
       * authority by itself: live GitHub protection must match it immediately
       * before evidence capture, remote handoff, and PR creation.
       */
      protectedRemote?: {
        /** Operator expects live branch protection; autonomous remote-main delivery requires true. */
        branchProtection: boolean;
        /**
         * Expected checks in the live GitHub policy. Remote-main delivery requires
         * typed context+App identities; legacy strings remain parseable but
         * are deliberately non-authoritative.
         */
        requiredChecks: ProtectedRemoteRequiredCheckExpectation[];
      };
      /** Optional exact per-repository PR-only registry. Presence disables global fallback. */
      protectedRemotes?: ProtectedRemoteRepositoryExpectation[];
      /**
       * M56 (v5): permit MID-tier (strong open model) proposals to auto-apply
       * to a BRANCH / PR - never to `main`. Separate, DEFAULT-OFF sub-flag, so
       * enabling main auto-merge does not implicitly enable the branch path.
       */
      midToBranch?: boolean;
	      /** Permit auto-merge when NO verification commands are detected (default false = fail-closed). */
	      allowWithoutVerification?: boolean;
	      /** Max verification-before-judge runs per auto-merge pass (default judgePerPass). */
	      verifyBeforeJudgePerPass?: number;
	    };
    /**
     * M181: generative engine - "rip mode". DEFAULT false (opt-in).
     *
     * When true, the fleet is available as a generative work source: a frontier
     * model invents bold, net-new features (source:'invent') rather than only
     * scanning for maintenance tasks. The daemon auto-wiring is flag-gated here;
     * the `ashlr invent` CLI always works regardless of this flag.
     *
     * CREATION ONLY: generated items are net-new capabilities, UX leaps, and bold
     * features. Dependency bumps, lint, doc-comments, and TODO restoration are
     * explicitly forbidden by the generative prompt.
     */
    generative?: boolean;
    /**
     * M52: per-engine OS-level confinement profiles. DEFAULT ABSENT (v4 env-only).
     * When present, external engine spawns are wrapped with a platform-native
     * read-jail (macOS sandbox-exec, Linux bwrap) that confines file reads to the
     * worktree + vendor config homes and optionally blocks network egress.
     * A `*` key sets a fleet-wide default; per-engine keys override it.
     * Absent ⇒ exactly v4 behavior (env-only containment, no OS jail).
     */
    confinement?: Partial<Record<EngineId | '*', {
      /** 'off' (v4 env-only, default) | 'os' (wrap spawn in an OS jail). */
      mode?: 'off' | 'os';
      /** Extra absolute paths the agent may READ beyond the worktree + vendor homes. */
      readAllowed?: string[];
      /** Allow outbound network from the contained process (default false). */
      networkEgress?: boolean;
      /**
       * When mode 'os' but the platform has no jail binary: 'fallback' (env-only,
       * audited) | 'fail' (terminal). Default 'fallback'.
       */
      onUnsupported?: 'fallback' | 'fail';
    }>>;
    /**
     * M247 / SPEC-INFERENCE-FABRIC Phase F1: InferenceGateway config.
     * DEFAULT ABSENT → behavior is byte-identical to pre-M247.
     */
    fabric?: {
      /**
       * Enable the InferenceGateway (consolidates routing into one traceable
       * decision object, fixes learned-router.ts:tierOf latent bug).
       * DEFAULT false → old routing code paths run unchanged.
       */
      gateway?: boolean;
      /**
       * M334 stage 1: run the gateway OBSERVE-ONLY beside the live legacy
       * routing path and record decision divergences to
       * ~/.ashlr/fabric/gateway-shadow-*.jsonl (divergenceStats() evaluates
       * the CONTRACT-M334 stage-2 exit criteria). THE LEGACY RESULT ALWAYS
       * WINS - shadow mode never changes a routing decision. Ignored when
       * fabric.gateway is already true. DEFAULT false.
       */
      gatewayShadow?: boolean;
      /**
       * M249: RunCache shadow mode - compute cache keys and log would-hit/would-miss
       * to the decisions ledger. NEVER short-circuits a spawn or serves a cached diff.
       * Pure measurement phase. DEFAULT false → byte-identical to pre-M249.
       */
      cacheShadow?: boolean;
      /**
       * M250 (NOT YET IMPLEMENTED): Live cache short-circuit. Requires Mason's explicit
       * sign-off after the 72h shadow-mode measurement gate passes.
       * DEFAULT false → live cache path is not implemented in M249.
       */
      cache?: boolean;
      /**
       * M250 Resource Control Plane: enable resource-aware backend demoting in the
       * gateway. When true, the gateway senses per-backend headroom and demotes
       * exhausted/throttled backends to the next available alternative.
       * DEFAULT false → byte-identical to pre-M250. Requires fabric.gateway=true.
       */
      resourceAware?: boolean;
      /**
       * M255 Concurrent Multi-Backend Dispatcher: when true, the daemon tick
       * dispatches items across ALL backends with headroom IN PARALLEL instead
       * of the serial per-item loop. Each backend's concurrency is bounded by
       * its per-availability slot count (open→maxSlotsPerBackend, near→half,
       * throttled/exhausted/unreachable/unknown→0).
       * DEFAULT false → serial path runs UNCHANGED (byte-identical to pre-M255).
       * Requires fabric.gateway=true for full routing trace.
       */
      concurrentDispatch?: boolean;
      /**
       * M255: maximum concurrent slots per backend when concurrentDispatch=true.
       * open backends get this many slots; near backends get ceil(N/2);
       * backends that report capUnit='concurrent' are further clamped by their
       * remaining local concurrency.
       * DEFAULT 3.
       */
      maxSlotsPerBackend?: number;
      /**
       * M256 Workhorse Dispatch: when true (alongside concurrentDispatch=true),
       * local-mid bulk items are spread evenly across WORKHORSE_BACKENDS
       * (local-coder, codex, nim) that have headroom. Protected gateway choices
       * such as frontier, throttled, budget-pause, and resource-pause decisions
       * keep their route hints.
       *
       * Safety: 0-slot governor still holds; codex retains frontier tier for
       * trust/merge decisions; only bulk route spreading is changed.
       * DEFAULT false → byte-identical to pre-M256. Requires concurrentDispatch=true.
       */
      workhorseDispatch?: boolean;
    };
    /**
     * Production velocity profile. DEFAULT OFF. When true, or when configured
     * as `{ "profile": "resource-control", "enabled": true }`, the daemon
     * materializes the resource-control lane as normal Fabric flags: gateway,
     * resourceAware, concurrentDispatch, and workhorseDispatch. It also makes
     * local/NIM/Kimi concurrent caps explicit and lets queue selection fill all
     * currently available resource slots.
     *
     * This grants no merge/push/apply authority; proposal-first gates remain
     * unchanged.
     */
    productionVelocity?: boolean | {
      enabled?: boolean;
      profile?: 'off' | 'resource-control';
      fillQueueToSlots?: boolean;
      stalePendingTtlHours?: number;
      maxSlotsPerBackend?: number;
      localMaxConcurrent?: number;
      nimMaxConcurrent?: number;
      kimiMaxConcurrent?: number;
    };
    /**
     * M250 Resource Control Plane: per-backend weekly message/token caps.
     * Used by the ResourceMonitor to determine when to demote a backend.
     *
     * Example:
     *   "limits": { "claude": { "weeklyMessageCap": 2000, "window": "7d" } }
     *
     * NOTE: This extends the existing limits field (which tracks rolling dispatch
     * counts for rate-limiting) with subscription-window awareness. The two
     * concerns are separate: `limits.claude.max` is the fleet dispatch rate;
     * `claudeResource.weeklyMessageCap` is the subscription cap signal.
     */
    claudeResource?: {
      /**
       * Estimated 5-hour message cap for Claude Code subscription sensing.
       * When absent, the ResourceMonitor uses a conservative default.
       */
      fiveHourMessageCap?: number;
      /**
       * Optional 5-hour token cap override. Message-count sensing is usually
       * the better Claude Code subscription proxy.
       */
      fiveHourTokenCap?: number;
      /**
       * Fleet-only Claude token budget. When set, ResourceMonitor measures the
       * fleet decisions ledger instead of interactive transcript usage.
       */
      weeklyTokenBudget?: number;
      /** Fleet-only Claude spend budget in USD. */
      weeklyCostBudgetUsd?: number;
      /**
       * Estimated weekly message cap for the Claude subscription plan.
       * Mason sets this to his plan's limit (e.g. 2000 for Pro, 5000 for Max).
       * The ResourceMonitor sums stats-cache.json messageCount over 7d and
       * compares to this value. CONSERVATIVE: counts human + fleet combined.
       */
      weeklyMessageCap?: number;
      /** Window label for the cap (default '7d'). */
      window?: string;
      /**
       * Protect this percent of the weekly cap for human sessions.
       * Fleet backs off when usage >= protectPct (default 85).
       * Example: 85 means fleet stops routing to claude at 85% used,
       * preserving 15% headroom for interactive sessions.
       */
      protectPct?: number;
    };
    /**
     * Operator resource overrides for known external capacity events that are
     * not reliably discoverable from local telemetry, such as a vendor weekly
     * lockout. Expired overrides are ignored automatically.
     *
     * Example:
     *   "resourceOverrides": {
     *     "claude": {
     *       "availability": "exhausted",
     *       "until": "2026-07-03T09:00:00-04:00",
     *       "reason": "Claude Code weekly usage exhausted"
     *     }
     *   }
     */
    resourceOverrides?: Record<string, {
      availability?: 'open' | 'near' | 'throttled' | 'exhausted' | 'unreachable' | 'unknown';
      until?: string | number;
      resetsAt?: number;
      reason?: string;
      usedPct?: number;
      cap?: number;
      capUnit?: 'messages' | 'tokens' | 'requests' | 'concurrent' | null;
      capWindow?: string;
    }>;
    /**
     * M250 Resource Control Plane: local/Ollama concurrency config.
     */
    local?: {
      /**
       * Maximum concurrent Ollama requests (default 1).
       * Matches the OLLAMA_NUM_PARALLEL env var default.
       */
      maxConcurrent?: number;
      /** Ollama base URL (default 'http://localhost:11434'). */
      baseUrl?: string;
    };
    /**
     * M151: opt-in EDV (independent/external) verification signal folded into
     * backlog item scoring. DEFAULT false. Previously read only via an untyped
     * `(cfg.foundry as Record<string, unknown>)?.['edvVerify']` cast in
     * src/core/portfolio/backlog.ts - this only adds type safety/
     * discoverability, no behavior change.
     */
    edvVerify?: boolean;
    /**
     * M185: gate for the `ashlrcode` (ac) autonomous executor path. DEFAULT
     * false (opt-in). Previously read only via an untyped
     * `(cfg.foundry as Record<string, unknown>)?.['ashlrcodeExecutor']` cast
     * in src/core/run/ashlrcode-engine.ts.
     */
    ashlrcodeExecutor?: boolean;
    /**
     * Spec-contract acceptance-criteria checking gate. DEFAULT false
     * (disabled - emptyDetail short-circuit). Previously read only via an
     * untyped `(cfg?.foundry as Record<string, unknown>)?.['specContract']`
     * cast in src/core/run/spec-contract.ts.
     */
    specContract?: boolean;
    /**
     * Inject a lightweight repo map into sandboxed-engine prompts. DEFAULT
     * false. Previously read only via an untyped
     * `(cfg.foundry as Record<string, unknown>)?.['repoMap']` cast in
     * src/core/run/sandboxed-engine.ts (sibling to `localization`, which
     * remains untyped/out of scope for this pass).
     */
    repoMap?: boolean;
    /**
     * Repair-treatment maintenance pass toggle. DEFAULT true (opt-out via
     * false). Discovered live in ~/.ashlr/config.json during the M340b type
     * audit - previously read only via untyped
     * `(liveCfg.foundry as Record<string, unknown>)?.['proposalRepair']`
     * casts in src/core/daemon/loop.ts (3 sites) and src/core/fleet/status.ts.
     * NOT YET present in KNOWN_FOUNDRY_KEYS (src/core/effective-config.ts),
     * so a live config setting it currently trips a false-positive "unknown
     * foundry key" warning - flagged separately for that file's owner.
     */
    proposalRepair?: boolean;
  };
  /**
   * M24: optional autonomous-operator (daemon) tuning. When unset, the daemon
   * falls back to its hard-coded conservative defaults. This NEVER widens the
   * daemon's authority - the daemon is proposal-only by construction; these
   * fields only bound HOW MUCH it may propose (budget/items/parallel/interval).
   */
  daemon?: Partial<DaemonConfig>;
  /**
   * M33: optional plugin-system configuration. Additive - absent in old configs
   * and defaults to { enabled: [], settings: {}, integrity: {} } via defaultConfig().
   * DEFAULT EMPTY: enabled:[] means NO plugins load.
   */
  plugins?: {
    /** Plugin names that are permitted to load (default empty = load nothing). */
    enabled: string[];
    /** Per-plugin key/value settings. Key = plugin name, value = arbitrary object. */
    settings: Record<string, Record<string, unknown>>;
    /**
     * Per-plugin integrity pins. Key = plugin name.
     * Value = "sha256:<64-hex-char>" hash of the plugin's entry file.
     * A missing pin causes the plugin to be refused at load time.
     */
    integrity: Record<string, string>;
  };
  /**
   * M89: Fleet→Pulse OTLP exporter. When enabled, the daemon emits fleet
   * activity (ticks + proposals) as OTLP/JSON spans to ashlr-pulse after
   * each tick. Auth via ASHLR_PULSE_PAT env var (never stored in config).
   * DEFAULT DISABLED - no telemetry is sent without explicit opt-in.
   */
  pulse?: {
    /** Enable fleet→pulse OTLP export (default false). */
    enabled?: boolean;
    /** OTLP endpoint base URL (default 'http://localhost:3000'). */
    endpoint?: string;
  };
  /**
   * M109: Local user identity - who owns this machine's fleet work.
   *
   * Set per machine; the cofounder sets theirs on their machine. Fleet activity
   * (proposals + goals created here) is stamped with this identity and carried
   * in OTLP spans as `ashlr.fleet.owner` → ashlr-pulse peer-share views group
   * by owner so Mason and his cofounder each see "whose fleet work is whose".
   *
   * Optional and backward-compatible: absent → owner stamps are undefined,
   * pulse attributes are omitted, and all existing behavior is unchanged.
   *
   * Example (Mason's machine):
   *   "user": { "id": "mason@ashlr.ai", "name": "Mason" }
   * Example (cofounder's machine):
   *   "user": { "id": "cofounder@ashlr.ai", "name": "Alex" }
   */
  user?: {
    /** Stable identifier - email recommended (matches pulse peer_share user_id). */
    id?: string;
    /** Display name shown in pulse team views. */
    name?: string;
  };
  /** RQ-ONB-2: Connect plan picks (resource id -> tier), written by POST /api/onboard/plan-tier. */
  onboard?: {
    planTiers?: Record<string, string>;
    /** RQ-ONB-5: "This computer" pairing record, written by POST /api/onboard/pair; cleared by unpair. */
    computer?: {
      /** ISO timestamp pairing first completed; kept across re-pairs. */
      pairedAt: string;
      /** ISO timestamp the last pair observed the daemon service in place. */
      lastSeenAt: string;
    };
  };
  /**
   * M111: Multi-machine fleet work-queue coordination. DEFAULT ABSENT (off) -
   * single-machine behavior is unchanged when this block is missing.
   *
   * `filesystem` authority requires an explicit `trustedCoherentStorage:true`
   * operator attestation for a coherent shared filesystem with linearizable
   * exclusive create, rename, hard-link, fsync, and read-after-write semantics.
   * Local primitive probing cannot verify cross-host linearizability. Replicated
   * sync folders such as iCloud Drive and Dropbox are unsupported: they are not
   * consensus stores and cannot provide execution authority.
   */
  fleet?: {
    sharedQueue?: {
      /**
       * 'off'        - single-machine mode (default, no shared file).
       * 'filesystem' - multi-machine via a JSON file on a shared path.
       */
      mode: 'off' | 'filesystem';
      /**
       * Absolute path to the shared folder where ashlr-fleet-queue.json is
       * stored. Required when mode is 'filesystem'. Ignored when mode is 'off'.
       */
      path?: string;
      /**
       * Explicit operator attestation that every worker accesses the same
       * coherent filesystem and observes linearizable queue operations.
       * Defaults to false. Filesystem queue authority must fail closed unless
       * this is exactly true; a local capability probe is not this attestation.
       * Enabling also attests that legacy writers were drained and the v2 fleet
       * was moved to a fresh queue path.
       */
      trustedCoherentStorage?: boolean;
      /**
       * Stable identifier for this machine in the shared queue.
       * Defaults to os.hostname(). Override when two machines share a hostname.
       */
      machineId?: string;
      /**
       * How long (ms) a claimed item is leased to this machine before another
       * machine may reclaim it (failover). Default 300_000 (5 min).
       */
      leaseMs?: number;
    };
  };

  /**
   * M137: iMessage bidirectional channel. DEFAULT DISABLED - no messages are
   * sent or read unless enabled:true AND imessageHandle is set.
   *
   * macOS-only (darwin). No-op on other platforms.
   *
   * Required macOS permissions:
   *   - Automation → Messages  (osascript tell application "Messages" to send)
   *   - Full Disk Access        (read ~/Library/Messages/chat.db for replies)
   *
   * SECURITY: handle lives in ~/.ashlr/config.json, NEVER committed to source.
   * Only numeric replies (1-N) resolve requests - no free-form command execution.
   */
  comms?: {
    /** Enable the comms channel. Default false. */
    enabled?: boolean;
    /**
     * Transport selection. Default 'imessage' (legacy).
     * Set to 'telegram' to use the Telegram Bot API instead.
     */
    channel?: 'imessage' | 'telegram';
    /**
     * Mason's iMessage address - phone number ("+15555550100") or Apple ID
     * email. Set in ~/.ashlr/config.json. NEVER commit this value.
     * Only used when channel === 'imessage' (or channel is unset).
     */
    imessageHandle?: string;
    /** iMessage service name. Default 'iMessage'. */
    service?: 'iMessage';
    /**
     * Telegram Bot API configuration. Only used when channel === 'telegram'.
     * botToken - from @BotFather. Can also be set via TELEGRAM_BOT_TOKEN env.
     *            NEVER commit this value.
     * chatId   - numeric chat id to send to / accept messages from.
     *            Run `ashlr comms setup-telegram` to discover it.
     */
    telegram?: {
      /** Bot API token from @BotFather. NEVER commit. */
      botToken?: string;
      /** Numeric chat id. Run `ashlr comms setup-telegram` to find it. */
      chatId?: string;
    };
    /**
     * M177: how often the `cycle` subcommand (driven by the 3-min poller) will
     * automatically send a fleet digest. Default 6 hours.
     */
    digestIntervalHours?: number;
    /**
     * M177: how often the `cycle` subcommand will automatically post the
     * Elon strategic question (ask-vision). Default 24 hours.
     */
    askVisionIntervalHours?: number;
    /**
     * Hours before an unsent pending request, or a sent question/approval that
     * was never answered, is expired. Default 48. Expiry never counts as an
     * answer; it only stops one stale question from blocking every later send.
     */
    requestTtlHours?: number;
    /**
     * M212: enable proactive fleet event notifications (merge shipped,
     * anomaly, decision-needed, daily standup). Default false.
     * Only fires when channel === 'telegram' and Telegram is configured.
     */
    proactive?: boolean;
    /**
     * M257 Director switch. @deprecated 3.14 - the Director is retired
     * (comms/director.ts): the Leader is the one strategic brain and talks
     * to Mason through the Leader thread. Kept so existing configs still
     * parse; it turns nothing on (the web status line reports it as set).
     */
    director?: boolean;
    /**
     * 3.15 the Leader line on Telegram (comms/leader-line.ts): scheduled
     * briefs, event pings, intent routing ("status", "go build X"). Default on
     * whenever the Telegram channel is configured; false turns the scheduled
     * briefs / pings off (conversation still works). While it is on, the
     * 6-hourly change digest stays silent - the briefs carry what shipped.
     */
    leaderLine?: boolean;
    /**
     * 3.15 brief times, local "HH:MM" in `timeZone`: the first is the morning
     * brief, the second the evening recap. Default ["08:00", "19:00"].
     */
    briefTimes?: string[];
    /** 3.15 IANA timezone for briefs and quiet hours. Default "America/New_York". */
    timeZone?: string;
    /**
     * 3.15 quiet hours (local hours, [start, end)): only urgent pings go out;
     * everything else waits for the morning brief. Default { start: 23, end: 7 }.
     */
    quietHours?: { start: number; end: number };
    /** 3.15 most proactive (non-brief, non-reply) Leader pings per local day. Default 6. */
    maxPingsPerDay?: number;
    /** 3.15 the repo "go build X" targets when Mason names none. Default "ashlrai/ashlr-hub" (Ashlr Verse). */
    leaderRepo?: string;
    /**
     * M214: OTLP endpoint for fleet-pulse emit (GenAI-OTel spans).
     * Takes precedence over PULSE_OTLP_URL env and cfg.pulse.endpoint.
     * Example: 'https://pulse.example.com' (no trailing slash).
     * Only used when cfg.foundry.pulseEmit === true.
     */
    pulseOtlpUrl?: string;
  };
  /**
   * V3.10 reasoning store (src/core/reasoning/). Stored reasoning is scrubbed,
   * local-only, 0600, and never replayed into prompts.
   */
  reasoning?: {
    /**
     * Also ingest Mason's INTERACTIVE Codex Desktop rollouts, not just
     * non-interactive `codex exec` ones. Default false (unset): those are
     * personal sessions, so they need explicit opt-in. The env var
     * `ASHLR_REASONING_CODEX_DESKTOP=1` turns it on too
     * (see reasoning/ingest-codex.ts).
     */
    codexDesktop?: boolean;
  };
  /**
   * 3.15 Devin lane (src/core/devin/). Off unless `enabled` is exactly true -
   * `ashlr devin connect` turns it on after storing the key in the macOS
   * Keychain. The API key is NEVER read from or written to this file.
   */
  devin?: {
    enabled?: boolean;
    /**
     * Let the fleet launch Devin sessions without a click (origin `fleet`).
     * Default false. Even when true a fleet launch also needs a live standing
     * grant whose current stage names the `devin` engine (producer-only Devin
     * seat) and the repo, the budget mode, and the Devin budget's reserve and
     * fleet caps (devin/fleet-launcher.ts). A Devin PR merges only when two
     * judges from different families (never Devin) ship it (merge-gates.ts G6).
     */
    fleet?: boolean;
    /**
     * SessionCreateRequest.devin_mode, pinned so the producer is a known
     * agent mode (`fusion` - multi-model routing - is deliberately not
     * accepted). Default 'normal'.
     */
    mode?: 'normal' | 'fast' | 'lite' | 'ultra';
    /**
     * The model a NEW Devin (CLI) chat starts on - any id, family slug or
     * alias `devin models list` prints (core/devin/models.ts resolves it).
     * Default 'swe-2-high' (SWE-2, listed Free). Each chat can still pick
     * another model; this only decides the picker's default.
     */
    defaultModel?: string;
    /**
     * 3.15: the model the fleet's local Devin CLI engine (`devin-cli`,
     * devin/cli-engine.ts) runs. Default `swe-2-high`. Only the free SWE-2
     * models (swe-2-high / swe-2-medium / swe-2-max) run under autonomy - a
     * billed model's spend cannot be read back, so the lane holds instead.
     * A sibling of `fleet` (which is a boolean the launcher checks `=== true`).
     */
    fleetModel?: string;
  };
}
