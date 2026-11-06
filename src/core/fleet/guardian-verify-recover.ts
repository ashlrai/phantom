import { GUARDIAN_VERIFY_DEADLINE, type GuardianOptions, type GuardianSummary } from './guardian-verify-loop.js';
import { runGuardianVerifyExclusive, type GuardianVerifyExclusiveDeps, type GuardianVerifyExclusiveResult } from './guardian-verify-exclusive.js';
import { drainGuardianInfraRetries, type GuardianDrainDeps, type GuardianDrainSummary } from './guardian-retry-drain.js';

/**
 * Verify-then-recover orchestration behind `fleet guardian-verify --retry-infra`.
 * Phase 1 is the ordinary exclusive verification over the caller's state file.
 * When it finishes inside the shared deadline — never refused, cancelled or
 * deadline-exhausted — phase 2 drains the eligible infrastructure-failure queue
 * with apply=true into per-attempt state files under a caller-provided,
 * already-existing directory, with only the remaining shared budget. The source
 * state is never written or overwritten; the newest verified attempt state is
 * the authoritative latest. `final` folds the newest verified loop summary,
 * which already counts every manifest-bound identity in the state it verified,
 * so recovery is claimed only from verified results, never from a drain that ran.
 */
export interface GuardianVerifyRecoverOptions {
  manifest: string; state: string; outputDir: string;
  maxRetries: number; timeoutMs: number;
  maxPasses: number; intervalMs: number;
  signal?: AbortSignal; now?: () => number;
}

export interface GuardianVerifyRecoverDeps extends GuardianDrainDeps {
  /** Loop-level verifier seam forwarded through the exclusive wrapper into both phases. */
  run?: GuardianVerifyExclusiveDeps['run'];
  drain?: typeof drainGuardianInfraRetries;
  now?: () => number;
}

export interface GuardianVerifyRecoverReport {
  verify: GuardianVerifyExclusiveResult;          // phase 1 outcome from the exclusive wrapper
  retry: GuardianDrainSummary | null;             // phase 2 drain summary; null when recovery never started
  retrySkipped: 'refused' | 'cancelled' | 'deadline' | null; // why phase 2 never started; null when it ran
  latestState: string | null;                     // newest verified attempt, else the source
  recovered: number;                              // verified retry attempts; zero when nothing recovered
  final: GuardianSummary | null;                  // newest verified manifest-bound fold
}

export async function runGuardianVerifyRecover(
  options: GuardianVerifyRecoverOptions,
  deps: GuardianVerifyRecoverDeps = {},
): Promise<GuardianVerifyRecoverReport> {
  const now = options.now ?? Date.now;
  const drain = deps.drain ?? drainGuardianInfraRetries;
  const exclusive = deps.verify ?? runGuardianVerifyExclusive;
  let final: GuardianSummary | null = null;
  const verify = async (o: GuardianOptions, d?: GuardianVerifyExclusiveDeps): Promise<GuardianVerifyExclusiveResult> => {
    const outcome = await exclusive(o, d ?? { run: deps.run });
    if (outcome.state === 'ran') final = outcome.summary;
    return outcome;
  };
  const deadlineAt = now() + options.timeoutMs;
  const initial = await verify(
    {
      manifest: options.manifest, state: options.state,
      maxPasses: options.maxPasses, intervalMs: options.intervalMs,
      timeoutMs: options.timeoutMs, signal: options.signal,
    },
    { run: deps.run },
  );
  const report: GuardianVerifyRecoverReport = {
    verify: initial, retry: null, retrySkipped: null,
    latestState: initial.state === 'ran' ? options.state : null,
    recovered: 0, final,
  };
  if (initial.state === 'refused') { report.retrySkipped = 'refused'; return report; }
  if (initial.summary.deadlineExceeded || options.signal?.reason === GUARDIAN_VERIFY_DEADLINE) { report.retrySkipped = 'deadline'; return report; }
  if (initial.summary.cancelled || options.signal?.aborted) { report.retrySkipped = 'cancelled'; return report; }
  const remaining = Math.floor(deadlineAt - now());
  if (remaining < 1) { report.retrySkipped = 'deadline'; return report; }
  report.retry = await drain(
    {
      manifest: options.manifest, sourceState: options.state,
      outputDir: options.outputDir, maxRetries: options.maxRetries,
      timeoutMs: remaining, apply: true, signal: options.signal, now,
    },
    { select: deps.select, prepare: deps.prepare, verify, onAttempt: deps.onAttempt },
  );
  report.recovered = report.retry.verified;
  if (report.retry.latestOutput) report.latestState = report.retry.latestOutput;
  report.final = final;
  return report;
}
