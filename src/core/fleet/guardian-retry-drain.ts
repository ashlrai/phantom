import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GUARDIAN_VERIFY_DEADLINE, GUARDIAN_VERIFY_MAX_TIMEOUT_MS, type GuardianOptions } from './guardian-verify-loop.js';
import { runGuardianVerifyExclusive, type GuardianVerifyExclusiveDeps, type GuardianVerifyExclusiveResult } from './guardian-verify-exclusive.js';
import { selectNextGuardianInfraRetry } from './guardian-retry-next.js';
import { prepareGuardianRetryState } from './guardian-retry-state.js';

// Bounded drain of the guardian retry queue: where `guardian-retry` prepares
// and optionally verifies exactly one eligible infrastructure failure, the
// drain admits up to `maxRetries` distinct repo+sha identities in one
// invocation. Each admission is a fresh exclusive-verification cycle over a
// unique per-attempt state path under the caller's output directory; the
// selector is the only work chooser, and attempted identities are tracked so
// a failure that stays infra-red is never retried twice in one run and can
// never starve the next entry. The original source state is never written.
export const GUARDIAN_DRAIN_MAX_RETRIES = 20;

/** 'planned' preview found work; 'no-work' nothing eligible at first selection;
 * 'drained' eligible set emptied after a verified attempt; 'exhausted' only
 * already-attempted identities remain; 'max-retries' bound reached; 'deadline'
 * total deadline hit; 'refused' exclusive verification refused; 'collision'
 * per-attempt output already existed, never overwritten; 'cancelled'
 * non-deadline abort; 'unsafe' validation/prepare/verify failed. */
export type GuardianDrainTermination =
  | 'planned' | 'no-work' | 'drained' | 'exhausted' | 'max-retries'
  | 'deadline' | 'refused' | 'collision' | 'cancelled' | 'unsafe' | 'observer-error';

export interface GuardianDrainOptions {
  manifest: string; sourceState: string; outputDir: string;
  maxRetries: number; timeoutMs: number; apply: boolean;
  signal?: AbortSignal; now?: () => number;
}

export interface GuardianDrainAttempt {
  attempt: number; repo: string; sha: string;
  outcome: 'verified' | 'refused'; refusal: string | null; latestOutput: string | null;
}

export interface GuardianDrainDeps {
  onAttempt?: (attempt: GuardianDrainAttempt) => void | Promise<void>;
  select?: typeof selectNextGuardianInfraRetry;
  prepare?: typeof prepareGuardianRetryState;
  verify?: (options: GuardianOptions, deps?: GuardianVerifyExclusiveDeps) => Promise<GuardianVerifyExclusiveResult>;
}

export interface GuardianDrainSummary {
  mode: 'preview' | 'apply'; termination: GuardianDrainTermination;
  attempts: number; verified: number; refused: number;
  attempted: { repo: string; sha: string }[]; planned: { repo: string; sha: string }[];
  latestOutput: string | null;
}

const attemptName = (n: number): string => `guardian-drain-attempt-${n}.json`;
const stop = (signal?: AbortSignal): GuardianDrainTermination | null =>
  signal?.aborted ? (signal.reason === GUARDIAN_VERIFY_DEADLINE ? 'deadline' : 'cancelled') : null;

export async function drainGuardianInfraRetries(
  options: GuardianDrainOptions,
  deps: GuardianDrainDeps = {},
): Promise<GuardianDrainSummary> {
  const now = options.now ?? Date.now;
  const { select = selectNextGuardianInfraRetry, prepare = prepareGuardianRetryState, verify = runGuardianVerifyExclusive } = deps;
  const summary: GuardianDrainSummary = {
    mode: options.apply ? 'apply' : 'preview', termination: 'unsafe',
    attempts: 0, verified: 0, refused: 0, attempted: [], planned: [], latestOutput: null,
  };
  if (![options.manifest, options.sourceState, options.outputDir].every(p => isAbsolute(p) && p.length <= 4096)
    || !Number.isSafeInteger(options.maxRetries) || options.maxRetries < 1 || options.maxRetries > GUARDIAN_DRAIN_MAX_RETRIES
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS) return summary;
  if (!options.apply) {
    // Read-only plan: the selector validates manifest and state fully and
    // reports the admission the first attempt would take. Nothing is written.
    try {
      const probe = join(options.outputDir, attemptName(1));
      const selected = await select({ manifest: options.manifest, sourceState: options.sourceState, outputState: probe });
      if (selected) summary.planned = [{ repo: resolve(selected.repo), sha: selected.sha }];
      summary.termination = selected ? 'planned' : 'no-work';
    } catch { /* fall through to unsafe */ }
    return summary;
  }
  const dir = await stat(options.outputDir).catch(() => null);
  if (!dir?.isDirectory()) return summary;
  const deadlineAt = now() + options.timeoutMs;
  let current = options.sourceState;
  const attempted = new Set<string>();
  summary.termination = 'max-retries';
  while (summary.attempts < options.maxRetries) {
    const blocked = stop(options.signal);
    if (blocked) { summary.termination = blocked; break; }
    const remaining = Math.floor(deadlineAt - now());
    if (remaining < 1) { summary.termination = 'deadline'; break; }
    const attemptPath = join(options.outputDir, attemptName(summary.attempts + 1));
    let selected: { repo: string; sha: string } | null;
    try { selected = await select({ manifest: options.manifest, sourceState: current, outputState: attemptPath }); }
    catch { summary.termination = 'unsafe'; break; }
    if (!selected) { summary.termination = summary.attempts === 0 ? 'no-work' : 'drained'; break; }
    const repo = resolve(selected.repo);
    const identity = `${repo}${selected.sha}`;
    if (attempted.has(identity)) { summary.termination = 'exhausted'; break; }
    attempted.add(identity);
    summary.attempted.push({ repo, sha: selected.sha });
    try {
      await prepare({ manifest: options.manifest, sourceState: current, outputState: attemptPath, repo: selected.repo, sha: selected.sha });
    } catch (error) { summary.termination = (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'collision' : 'unsafe'; break; }
    summary.attempts++;
    const left = Math.floor(deadlineAt - now());
    const halted = left < 1 ? 'deadline' as const : stop(options.signal);
    if (halted) { summary.termination = halted; break; }
    let outcome: GuardianVerifyExclusiveResult;
    try { outcome = await verify({ manifest: options.manifest, state: attemptPath, maxPasses: 1, intervalMs: 1000, timeoutMs: left, signal: options.signal }); }
    catch { summary.termination = 'unsafe'; break; }
    if (outcome.state === 'refused') summary.refused++;
    else {
      summary.verified++;
      // Only a complete verified state is carried forward.
      current = attemptPath; summary.latestOutput = attemptPath;
    }
    try {
      await deps.onAttempt?.({ attempt: summary.attempts, repo, sha: selected.sha,
        outcome: outcome.state === 'refused' ? 'refused' : 'verified',
        refusal: outcome.state === 'refused' ? outcome.reason : null, latestOutput: summary.latestOutput });
    } catch { summary.termination = 'observer-error'; break; }
    if (outcome.state === 'refused') { summary.termination = 'refused'; break; }
    if (outcome.summary.deadlineExceeded) { summary.termination = 'deadline'; break; }
    if (outcome.summary.cancelled) { summary.termination = 'cancelled'; break; }
  }
  return summary;
}
