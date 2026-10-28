/** Shared engines contracts. Public entry point: ../types.ts. */

/** The set of engines `ashlr run` can delegate to (or run locally). */
export type EngineId =
  | 'builtin'
  | 'local-coder'
  | 'llama-server'
  | 'ashlrcode'
  | 'aw'
  | 'claude'
  | 'claude-api'
  | 'codex'
  | 'grok-cli'
  | 'devin-cli'
  | 'hermes'
  | 'kimi'
  | 'nim'
  | 'opencode'
  | 'meta-muse'
  | 'grok'; // M298: xAI Grok - OpenAI-compatible, tier mid (promotable to frontier via cfg.foundry.grok)

/** Minted private execution identity reference. Runtime validation is stricter. */
export type ExecutionIdentityRefV1 = string;

/** Opaque reference into the internal 0600 execution-identity private store. */
export type ExecutionIdentityPrivateRuntimeLocatorRefV1 = string;

export type ExecutionIdentityPlanV1 =
  | {
      kind: 'subscription';
      class: 'codex-max' | 'codex-custom';
      maxConcurrent: number;
    }
  | {
      kind: 'agent-credit';
      class: 'claude-agent-sdk-credit';
      maxConcurrent: number;
    }
  | {
      /** Claude Max remains reserved for direct interactive use in V1. */
      kind: 'interactive-reserved';
      class: 'claude-max';
      maxConcurrent: 0;
    }
  | {
      kind: 'local';
      class: 'local-runtime';
      maxConcurrent: number;
    }
  | {
      kind: 'metered';
      class: 'api-metered';
      maxConcurrent: number;
    };

/** One private identity behind a concrete engine. */
export interface ExecutionIdentitySpecV1 {
  ref: ExecutionIdentityRefV1;
  engine: EngineId;
  privateRuntimeLocatorRef: ExecutionIdentityPrivateRuntimeLocatorRefV1;
  plan: ExecutionIdentityPlanV1;
}

/** Default-off V1 gate. `shadowOnly` has no false state in this version. */
export interface ExecutionIdentityConfigV1 {
  enabled?: boolean;
  shadowOnly?: true;
  identities?: ExecutionIdentitySpecV1[];
}

/**
 * Explicitly enabled, digest-pinned observation-only local candidate.
 * Absence is the default-off state. Runtime validation additionally requires
 * engine `local-coder`, an exact model name, and a canonical full sha256 pin.
 */
export interface BestOfNShadowCandidateConfig {
  enabled: true;
  artifactDigest: string;
}

export interface BestOfNCandidateSpec {
  engine: EngineId;
  model?: string | null;
  shadow?: BestOfNShadowCandidateConfig;
}

/**
 * M45: trust tier of the backend that produced work. 'frontier' = a
 * merge-authority model (e.g. Opus 4.8 via Claude Code, GPT-5.5 via Codex);
 * 'local' = an on-device model. Only 'frontier' work may auto-merge to main
 * (enforced later via cfg.foundry.mergeAuthority).
 */
export type EngineTier = 'local' | 'mid' | 'frontier';

/** A fully-resolved external engine invocation (exact argv + optional cwd). */
export interface EngineCommand {
  /** Executable to spawn (e.g. 'claude', 'aw', 'ac', or 'phantom' when wrapped). */
  bin: string;
  /** Exact argument vector passed to `bin`. */
  args: string[];
  /** Working directory for the spawned process, when set. */
  cwd?: string;
}

/**
 * M50 (v5): the kind of a backend engine.
 *  - 'builtin'   - the in-process local agent loop (no external CLI).
 *  - 'cli-agent' - an external agent CLI spawned + contained (claude, codex, …).
 *  - 'api-model' - an OpenAI-compatible API endpoint driven through the run loop.
 */
export type EngineKind = 'builtin' | 'cli-agent' | 'api-model';

/**
 * M50 (v5): one segment of a declarative argv template. A plain string is a
 * literal argv element, EXCEPT the exact tokens '$GOAL' | '$CWD' | '$MODEL',
 * which are substituted (each as a SINGLE argv element - never shell-split, so a
 * goal containing '$CWD' or ';' is passed verbatim and never expanded). An
 * `{ optModel }` segment is emitted only when a concrete model is present.
 *
 * V3.10 `{ join }`: each part is substituted exactly as above, then the parts
 * are concatenated into ONE argv element. It exists for clap value options such
 * as grok's `--single=<goal>`: a leading-dash value is only accepted in the
 * `--opt=value` spelling, so a goal that starts with `-` must travel glued to
 * its flag rather than as the next element (where it would parse as a flag).
 */
export type ArgvSeg = string | { optModel: string[] } | { join: string[] };

/**
 * M50 (v5): a declarative backend engine specification. The registry
 * (`run/engine-registry.ts`) is the single source of truth for how an engine is
 * invoked, probed, and trust-tiered. Adding a backend is a config-only
 * `cfg.foundry.engines` entry that reuses this shape - no code branch.
 */
export interface EngineSpec {
  /** Stable engine id (matches an EngineId for builtins; any string for additions). */
  id: string;
  /** How this engine is driven. */
  kind: EngineKind;
  /** Trust tier; only 'frontier' carries merge-to-main authority. */
  tier: EngineTier;
  /** Executable name for a cli-agent (defaults to id when omitted). */
  bin?: string;
  /** PATH probe candidates (engineInstalled); defaults to [bin ?? id]. */
  bins?: string[];
  /** Base argv template (cli-agent). */
  argv?: ArgvSeg[];
  /** Extra argv appended when running unattended/autonomous. */
  autonomousArgv?: ArgvSeg[];
  /** OpenAI-compatible API wiring (api-model). */
  api?: {
    envKey: string;
    baseUrlEnv?: string;
    defaultBaseUrl?: string;
    defaultModel?: string;
    protocol: 'openai' | 'anthropic-messages';
  };
  /** Free-form capability tags used by capability-aware routing. */
  capabilities?: string[];
  /**
   * M260: canonical default model for this engine, used when no
   * cfg.foundry.models[engine], no opts.model, and no ASHLR_MODEL env.
   * Primarily for cli-agent entries (claude, codex) whose concrete model
   * cannot be read from an api.defaultModel sub-field.
   */
  defaultModel?: string;
}
