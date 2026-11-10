/**
 * Supervisor exit gate on the recorded self-tick run (recovered from
 * RQ-PHX-SELFTICKCHECK02SOLC2, #2915). `fleet self-tick-check` by default
 * answers "is the timer installed and active?"; a host supervisor
 * (launchd/systemd/cron wrapper) also needs "did the timer actually run
 * well, recently?" as a process exit status. This reads only
 * queue/self-tick-last.json and maps it to one stable reason code:
 *
 *   ok         — readable, fresh, ran, no failed steps (and apply when required)
 *   missing    — no recorded run
 *   unreadable — the record will not parse or fails validation
 *   future     — `at` is more than FUTURE_SKEW_SECONDS ahead of the clock; the
 *                reader clamps ageSeconds at 0, so a forged or clock-ahead
 *                record must never count as fresh
 *   stale      — ageSeconds exceeds maxAgeSeconds (inclusive boundary is fresh)
 *   busy       — the recorded run found the lock held and ran no step
 *   failed     — the recorded run has failed steps
 *   dry-run    — requireApply was set but the recorded run was a dry-run
 *
 * Precedence is the order above. It never spawns, locks, runs a tick or
 * writes; a missing queue directory is not created.
 */
import { readSelfTickLast } from './self-tick-last.js';

/** A record `at` this far ahead of the injected clock is reported 'future'. */
export const SELF_TICK_LAST_FUTURE_SKEW_SECONDS = 60;
export const SELF_TICK_LAST_DEFAULT_MAX_AGE_SECONDS = 1800;

export type SelfTickLastReason = 'ok' | 'missing' | 'unreadable' | 'future' | 'stale' | 'busy' | 'failed' | 'dry-run';

export interface SelfTickLastCheckOptions {
  runsDir: string;
  now: number; // ms epoch
  maxAgeSeconds?: number;
  requireApply?: boolean;
}

export interface SelfTickLastCheckReport {
  v: 1;
  healthy: boolean;
  reason: SelfTickLastReason;
  detail: string;
  at: string | null;
  ageSeconds: number | null;
  mode: 'apply' | 'dry-run' | null;
  ranState: 'ran' | 'busy' | null;
  failedSteps: string[];
  maxAgeSeconds: number;
  requireApply: boolean;
}

export function checkSelfTickLastRun(options: SelfTickLastCheckOptions): SelfTickLastCheckReport {
  const maxAgeSeconds = options.maxAgeSeconds ?? SELF_TICK_LAST_DEFAULT_MAX_AGE_SECONDS;
  const requireApply = options.requireApply === true;
  const view = readSelfTickLast(options.runsDir, options.now);
  const base = { v: 1 as const, maxAgeSeconds, requireApply };
  if (view === null || view.state === 'unreadable') {
    const reason = view === null ? 'missing' : 'unreadable';
    return {
      ...base, healthy: false, reason,
      detail: view === null ? 'no recorded self-tick run' : 'the recorded run will not parse or fails validation',
      at: null, ageSeconds: null, mode: null, ranState: null, failedSteps: [],
    };
  }
  const aheadMs = Date.parse(view.at) - options.now;
  let reason: SelfTickLastReason;
  let detail: string;
  if (aheadMs > SELF_TICK_LAST_FUTURE_SKEW_SECONDS * 1_000) {
    reason = 'future';
    detail = `recorded at ${view.at}, ${Math.floor(aheadMs / 1_000)}s ahead of this clock`;
  } else if (view.ageSeconds > maxAgeSeconds) {
    reason = 'stale';
    detail = `last run ${view.at} is ${view.ageSeconds}s old (> ${maxAgeSeconds}s)`;
  } else if (view.ranState === 'busy') {
    reason = 'busy';
    detail = 'the recorded run found the self-tick lock held; no step ran';
  } else if (view.failedSteps.length > 0) {
    reason = 'failed';
    detail = `failed steps: ${view.failedSteps.join(',')}`;
  } else if (requireApply && view.mode === 'dry-run') {
    reason = 'dry-run';
    detail = 'the recorded run was a dry-run; --require-apply needs an apply pass';
  } else {
    reason = 'ok';
    detail = `last run ${view.at} (${Math.floor(view.ageSeconds / 60)}m ago) ${view.mode} failed=none`;
  }
  return {
    ...base, healthy: reason === 'ok', reason, detail,
    at: view.at, ageSeconds: view.ageSeconds, mode: view.mode, ranState: view.ranState,
    failedSteps: [...view.failedSteps],
  };
}
