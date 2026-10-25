/**
 * Local inference complexity escalation (local-inference-plan.md slice P4).
 *
 * Pure, deterministic policy: decide whether a work step runs on the local
 * tier (high-volume coding, tool and test loops, drafts) or escalates to the
 * frontier tier. It extends the existing tier rules instead of adding a new
 * router: the local tier never gains main-merge authority (same as
 * `local-coder`, tier mid, frontier gate unchanged), and abliterated models
 * are never chosen for a step that holds credentials or merge rights.
 *
 * Escalate to frontier when any of:
 *   - the step merges to main (frontier-only, always);
 *   - the step needs credentials (phantom exec) and the local model is abliterated;
 *   - the task is planning or architecture;
 *   - the change touches a Tier-1 / protected path;
 *   - verify failed N times on local (default 2) or retries reached the cap (default 3);
 *   - the context exceeds the local model's window;
 *   - local inference is not configured or not reachable.
 * Otherwise stay local. Every decision names one closed reason code.
 */
import { isAbliteratedModel } from '../run/local-inference.js';

export const LOCAL_TASK_KINDS = ['edit', 'test', 'lint', 'tool-loop', 'draft', 'review', 'plan', 'architecture'] as const;
export type LocalTaskKind = (typeof LOCAL_TASK_KINDS)[number];

export type EscalationReason =
  | 'merge-to-main-frontier-only'
  | 'abliterated-with-credentials'
  | 'complex-task-kind'
  | 'protected-path'
  | 'verify-failures'
  | 'retry-cap'
  | 'context-over-local-limit'
  | 'local-unavailable'
  | 'local-ok';

export interface EscalationInput {
  kind: LocalTaskKind;
  /** The step would merge to main (or hold merge rights). */
  mergesToMain?: boolean;
  /** The step runs with project credentials (phantom exec). */
  needsCredentials?: boolean;
  /** Any changed path is Tier-1 / code-owned. */
  touchesProtectedPath?: boolean;
  failedVerifyAttempts?: number;
  retries?: number;
  contextTokens?: number;
  /** Local model context window; unknown means no context check. */
  localContextLimit?: number | null;
  /** Local server configured and reachable (P3 probe status 'reachable'). */
  localAvailable: boolean;
  /** Local model that would run the step. */
  localModel?: string | null;
}

export interface EscalationPolicy {
  maxLocalVerifyFailures: number;
  maxLocalRetries: number;
}

export const DEFAULT_ESCALATION_POLICY: Readonly<EscalationPolicy> = Object.freeze({
  maxLocalVerifyFailures: 2,
  maxLocalRetries: 3,
});

export interface EscalationDecision {
  lane: 'local' | 'frontier';
  reason: EscalationReason;
}

const COMPLEX_KINDS: ReadonlySet<LocalTaskKind> = new Set(['plan', 'architecture']);
const nonNeg = (n: unknown): number => (Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : 0);

/** Pure. Order matters: authority and safety rules first, then cost signals. */
export function decideLocalEscalation(
  input: EscalationInput,
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): EscalationDecision {
  const frontier = (reason: EscalationReason): EscalationDecision => ({ lane: 'frontier', reason });
  if (input.mergesToMain === true) return frontier('merge-to-main-frontier-only');
  if (input.needsCredentials === true && input.localModel && isAbliteratedModel(input.localModel)) {
    return frontier('abliterated-with-credentials');
  }
  if (!input.localAvailable) return frontier('local-unavailable');
  if (COMPLEX_KINDS.has(input.kind) || !(LOCAL_TASK_KINDS as readonly string[]).includes(input.kind)) {
    return frontier('complex-task-kind');
  }
  if (input.touchesProtectedPath === true) return frontier('protected-path');
  if (nonNeg(input.failedVerifyAttempts) >= Math.max(1, policy.maxLocalVerifyFailures)) return frontier('verify-failures');
  if (nonNeg(input.retries) >= Math.max(1, policy.maxLocalRetries)) return frontier('retry-cap');
  const limit = input.localContextLimit;
  if (typeof limit === 'number' && limit > 0 && nonNeg(input.contextTokens) > limit) return frontier('context-over-local-limit');
  return { lane: 'local', reason: 'local-ok' };
}

/**
 * Pure. The local lane can never be given main-merge authority, whatever the
 * config says: any attempt to promote returns false.
 */
export function localLaneMayMergeToMain(): false {
  return false;
}
