/** Shared doctor contracts. Public entry point: ../types.ts. */

/** Outcome of a single doctor health check. */
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

/** A single health check produced by `runDoctor`. */
export interface DoctorCheck {
  /** Stable check id (e.g. 'config', 'phantom', 'provider:ollama'). */
  id: string;
  /** Human-readable label for the check. */
  label: string;
  /** pass | warn | fail. */
  status: DoctorCheckStatus;
  /** One-line detail describing the observed state. */
  detail: string;
  /** Optional suggested remediation command/hint. */
  fix?: string;
}

/** Full one-glance health report from `ashlr doctor`. */
export interface DoctorReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** All checks performed, in display order. */
  checks: DoctorCheck[];
  /** Roll-up counts by status. */
  summary: { pass: number; warn: number; fail: number };
}

// ---------------------------------------------------------------------------
// M20: one-command onboarding + self-healing doctor/runtime
// ---------------------------------------------------------------------------

/**
 * M20: outcome of a single `doctor --fix` remediation attempt.
 *
 * One FixAction is produced per failing/warn DoctorCheck that `fixDoctor`
 * considers. SAFE + LOCAL + non-destructive only: create missing config from
 * defaults, rebuild a stale/missing index, create the ~/.local/bin symlink,
 * create the genome dir, register the ashlr MCP gateway (backup-first). NEVER
 * deletes/overwrites user data, NEVER auto-downloads models, NEVER touches
 * secrets. `applied` is whether the fix was performed; `manual` is true when
 * the check is fixable in principle but requires human action (left untouched).
 */
export interface FixAction {
  /** DoctorCheck.id this action corresponds to (e.g. 'config', 'index', 'local-bin', 'genome-memory', 'mcp-plugin'). */
  checkId: string;
  /** Human-readable label for what was (or would be) fixed. */
  label: string;
  /** Whether a safe automated remediation was actually performed. */
  applied: boolean;
  /** One-line detail: what was fixed, or why it was left for manual action. */
  detail: string;
  /** True when the check needs manual/human action and was deliberately not auto-fixed. */
  manual: boolean;
}

/**
 * M20: status of a single onboarding step produced by `onboard`.
 *
 *   'ok'       - already in the desired state / safe ensure succeeded.
 *   'wired'    - a mutating wire step completed (e.g. editor MCP registered).
 *   'detected' - something was detected + reported, no mutation performed.
 *   'skipped'  - step intentionally skipped (e.g. wire not requested).
 *   'manual'   - step needs human action (printed as guidance, never auto-done).
 */
export interface OnboardStep {
  /** Stable step name (e.g. 'config', 'models', 'editors', 'symlink', 'genome', 'phantom', 'doctor'). */
  name: string;
  /** Outcome of the step. */
  status: 'ok' | 'wired' | 'detected' | 'skipped' | 'manual';
  /** One-line human-readable detail - metadata only, never secrets. */
  detail: string;
}

/**
 * M20: full result of an idempotent, non-TTY-safe `ashlr init` onboarding run.
 */
export interface OnboardResult {
  /** All onboarding steps performed, in display order. */
  steps: OnboardStep[];
  /** True when the setup is complete enough to run (no blocking failures). */
  ready: boolean;
  /** Crisp next-step guidance lines (e.g. 'try: ashlr run / ashlr swarm / ashlr tui'). */
  nextSteps: string[];
}

/**
 * M20: bounds for self-healing runtime wrappers. ALL heal behavior is bounded
 * by these caps - there is never an unbounded restart/downgrade/backoff loop.
 */
export interface HealPolicy {
  /** Hard max number of heal-triggered retries (restart/downgrade/backoff). Bounded; never infinite. */
  maxRestarts: number;
  /** Whether OOM/model-error may downgrade to a SMALLER LOCAL model for a bounded retry. */
  allowDowngrade: boolean;
}

/**
 * M20: one self-heal event, surfaced to the caller's `onHeal` callback for
 * logging. Metadata only - never secrets.
 *
 *   'mcp-restart'     - a crashed MCP downstream was restarted (extends M3 skip-on-failure).
 *   'model-downgrade' - a local model OOM/error downgraded to a smaller local model.
 *   'rate-backoff'    - a cloud rate-limit triggered exponential backoff (only when allowCloud).
 */
export interface HealEvent {
  /** What kind of heal occurred. */
  kind: 'mcp-restart' | 'model-downgrade' | 'rate-backoff';
  /** One-line human-readable detail - metadata only, never secrets. */
  detail: string;
  /** 1-based attempt number that triggered this heal event. */
  attempt: number;
}
