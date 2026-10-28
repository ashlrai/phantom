/** Shared providers contracts. Public entry point: ../types.ts. */
import type { ApiBillingSummary, ApiMessageBilling } from './run.js';

// ---------------------------------------------------------------------------
// M2: identity & model awareness contract
// ---------------------------------------------------------------------------

/** Result of probing a single local-model/provider endpoint. Never throws. */
export interface ProviderEndpoint {
  /** Stable provider id ('lmstudio' | 'ollama' | custom). */
  id: 'lmstudio' | 'ollama' | string;
  /** Base/probe URL that was queried. */
  url: string;
  /** Whether the endpoint responded successfully. */
  up: boolean;
  /** Model ids/names reported by the endpoint (empty when down). */
  models: string[];
  /** Probe error message when `up` is false, else absent. */
  error?: string;
}

/** Aggregated view of all configured providers + the resolved active one. */
export interface ProviderRegistry {
  /** All probed endpoints, in chain order where possible. */
  providers: ProviderEndpoint[];
  /** Id of the first up provider in the chain, or null if none are up. */
  activeProvider: string | null;
  /** The configured provider preference chain (from cfg.models.providerChain). */
  chain: string[];
}

/** Read-only status of the Phantom secrets CLI. NEVER carries secret values. */
export interface PhantomCapabilitySnapshot {
  /** Status surfaces only ever expose metadata and secret names, never values. */
  valueMode: 'metadata-and-names-only';
  /** Count of safe secret names visible to the CLI. */
  secretCount: number;
  /** Known fleet secret identifiers, compared by name only. */
  knownFleetSecrets: {
    names: string[];
    present: string[];
    missing: string[];
    pulsePatPresent: boolean;
    pulseTokenPresent: boolean;
    pulseCredentialPresent: boolean;
  };
  /** Capability modes inferred without revealing secret values. */
  modes: {
    metadataStatus: boolean;
    childEnvInjectionAvailable: boolean;
    mcpServerAvailable: boolean;
    mutationRequiresHumanApproval: boolean;
  };
  /** Read-only command availability parsed from `phantom --help` only. */
  commands: {
    commandsKnown: boolean;
    setupAvailable: boolean;
    execAvailable: boolean;
    mcpAvailable: boolean;
    agentAvailable: boolean;
  };
}

export interface PhantomAgentReportRollup {
  valuesHidden: true;
  scannedRepos: number;
  validReports: number;
  failedReports: number;
  statusCounts: Record<string, number>;
  riskCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  requiresApprovalCount: number;
  delegationSafety?: {
    safetyCounts: {
      safe: number;
      unsafe: number;
      unknown: number;
    };
    statusCounts: Record<string, number>;
    primaryActionCounts: Record<string, number>;
  };
}

export interface PhantomStatus {
  /** Whether the `phantom` binary is on PATH. */
  installed: boolean;
  /** Reported version string, or null if unknown/unavailable. */
  version: string | null;
  /** Whether a Phantom vault/identity is initialized. */
  initialized: boolean;
  /** Secret NAMES only (never values). Empty when uninitialized/unavailable. */
  secretNames: string[];
  /** Values-free capability summary for readiness and fleet surfaces. */
  capability: PhantomCapabilitySnapshot;
  /** Aggregate-only agent report rollup, present only when explicitly requested and safely supported. */
  agentReport?: PhantomAgentReportRollup;
  /** Error message when status could not be fully determined, else absent. */
  error?: string;
}

/** A single message in a chat exchange with a provider. */
export interface ChatMessage {
  /** Message author role. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message text content. */
  content: string;
  /** Assistant tool calls retained together with their correlated results. */
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** Tool-call id this message responds to (for role 'tool'). */
  toolCallId?: string;
  /** Tool/function name (for role 'tool'). */
  name?: string;
}

/** Result of a single chat completion call. */
export interface ChatResult {
  /** Assistant text content (may be empty when only tool calls returned). */
  content: string;
  /** Tool calls the model requested, if any. */
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** Token accounting for this call. */
  usage: { tokensIn: number; tokensOut: number };
  /**
   * True only when `usage` came from exact finite nonnegative provider
   * counters. False/absent usage may be estimated and cannot release a
   * governed token reservation.
   */
  usageKnown?: boolean;
  /** Both fallback counts came from the existing local estimator, not normalized zeros. */
  usageEstimated?: boolean;
  /** Present only after exact provider accounting and durable API settlement. */
  billing?: ApiMessageBilling;
}

/**
 * Callable implementation carried by an agent tool spec.
 *
 * The signal is optional so existing one-argument executors remain assignable,
 * while cancellation-aware tools can own and terminate their in-flight work.
 */
export type ToolExecutor<TResult = unknown> = (
  args: unknown,
  signal?: AbortSignal,
) => Promise<TResult>;

/** Thin chat client over the active local provider (Ollama / LM Studio). */
export interface ProviderClient {
  /** Provider id this client targets. */
  id: string;
  /**
   * Resolved model name this client serves (M41). Optional/additive - plugin
   * providers may omit it. Used to resolve a model-adaptive ModelProfile.
   */
  model?: string;
  /** Whether the underlying model/provider supports tool calls. */
  supportsTools: boolean;
  /** Explicit opt-in required before a governed caller may contact this client. */
  authority?: ProviderClientAuthority;
  /** Optional metadata-only discovery for the exact endpoint/model; unknown is undefined. */
  getContextWindowTokens?(signal?: AbortSignal): Promise<number | undefined>;
  /** Metadata only: no provider reads or credential access. */
  getApiBillingSummary?(): ApiBillingSummary;
  /** Send a chat exchange (optionally with tool specs) and get a result. */
  chat(
    messages: ChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    limits?: ModelCallLimits,
  ): Promise<ChatResult>;
  /**
   * Streaming chat (M11): invoke `onDelta(textChunk)` for each incremental
   * content token, resolving to the SAME ChatResult shape as `chat()`
   * (final content + toolCalls + usage). Implementations fall back to `chat()`
   * (emitting the full content via a single `onDelta`) when the provider/model
   * does not support streaming or streaming errors.
   *
   * Optional at the type level so the M11 contract typechecks before the
   * provider agent implements it; the provider agent makes it concrete on both
   * the Ollama and LM Studio clients (callers must `?.`-guard until then).
   */
  chatStream?(
    messages: ChatMessage[],
    tools: unknown[] | undefined,
    onDelta: (t: string) => void,
    signal?: AbortSignal,
    limits?: ModelCallLimits,
  ): Promise<ChatResult>;
}

/** Hard request-level generation limits understood by provider adapters. */
export interface ModelCallLimits {
  readonly maxOutputTokens: number;
}

/** Runtime guarantees required by preventive model-call authority. */
export interface ProviderClientAuthority {
  readonly requestLimits: 'enforced';
  readonly usageAccounting: 'exact-provider-counters';
}
