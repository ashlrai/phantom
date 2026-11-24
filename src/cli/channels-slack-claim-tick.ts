/** Proactive claim notices for `phm channels slack run` (Nov12/13 Slack
 * coordination orders): each loop iteration may run one claim-notice pass,
 * at most once per interval, with no overlapping passes. The pass only appends `kind: 'note'` bus
 * envelopes; the run loop's own `listBusInboxAfter` drain delivers them
 * through `deliverSlackEnvelope`, so audience, confirmedByMason and policy
 * gates stay exactly where they were. KILL halts the pass like every other
 * outward channel. The tick never throws: a failed pass retries next interval. */
import { claimNoticePassDeps } from './fleet-claim-notices.js';
import { runClaimNoticePass, type ClaimNoticePassResult } from '../core/fleet/claim-notice-send.js';
import { killSwitchOn } from '../core/sandbox/policy.js';

export const CLAIM_NOTICE_TICK_INTERVAL_MS = 30_000;

export type ClaimNoticeTickOutcome =
  /** `deduped` is the pass result's `skipped` (notices already fenced by the sent ledger). */
  | { ran: true; sent: number; deduped: number; failed: number }
  | { ran: true; sent: number; deduped: number; failed: number;
      status: 'board-unavailable' | 'ledger-unavailable' | 'bindings-unavailable' | 'prev-unavailable'; reason: string }
  | { ran: true; sent: number; deduped: number; failed: number; status: 'dry-run' }
  | { ran: false; reason: 'interval' | 'in-flight' | 'kill-switch' | 'pass-error' | 'aborted' };

export interface ClaimNoticeTick {
  /** Runs a pass when the interval has elapsed. An aborted `signal` resolves
   * immediately so a bounded stop never waits on an in-flight pass. */
  maybeRun(signal?: AbortSignal): Promise<ClaimNoticeTickOutcome>;
}

export function createClaimNoticeTick(opts: {
  intervalMs?: number;
  now?: () => number;
  pass?: () => Promise<ClaimNoticePassResult>;
  killed?: () => boolean;
} = {}): ClaimNoticeTick {
  const intervalMs = opts.intervalMs ?? CLAIM_NOTICE_TICK_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const pass = opts.pass ?? (() => runClaimNoticePass(claimNoticePassDeps()));
  const killed = opts.killed ?? killSwitchOn;
  let lastAt: number | undefined;
  let inFlight = false;
  return {
    async maybeRun(signal) {
      if (signal?.aborted) return { ran: false, reason: 'aborted' };
      if (inFlight) return { ran: false, reason: 'in-flight' };
      const at = now();
      // Rebase on rollback and wait a full interval; repeated rollbacks never trigger immediate attempts.
      if (lastAt !== undefined && at < lastAt) lastAt = at;
      if (lastAt !== undefined && at - lastAt < intervalMs) return { ran: false, reason: 'interval' };
      // The attempt (not its success) starts the interval, so a failing or
      // KILLed pass is retried next interval rather than on every loop turn.
      lastAt = at;
      try {
        if (killed()) return { ran: false, reason: 'kill-switch' };
        // The underlying pass owns this guard, even if its caller aborts.
        // Defer invocation so synchronous throws also release the guard.
        inFlight = true;
        const running = Promise.resolve().then(pass).finally(() => { inFlight = false; });
        const result = signal === undefined ? await running : await new Promise<ClaimNoticePassResult | null>((resolve, reject) => {
          const onAbort = (): void => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          running.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
        if (result === null) return { ran: false, reason: 'aborted' };
        const counts = { ran: true as const, sent: result.sent, deduped: result.skipped, failed: result.failed };
        // These fixed codes keep arbitrary dependency errors out of the outcome.
        if (result.status === 'board-unavailable') {
          return { ...counts, status: result.status, reason: 'board-state-unknown' };
        }
        if (result.status === 'ledger-unavailable') {
          return { ...counts, status: result.status, reason: 'sent-ledger-unreadable' };
        }
        if (result.status === 'bindings-unavailable') {
          return { ...counts, status: result.status, reason: 'claim-bindings-unreadable' };
        }
        if (result.status === 'prev-unavailable') {
          return { ...counts, status: result.status, reason: 'prev-snapshot-unreadable' };
        }
        if (result.status === 'dry-run') return { ...counts, status: result.status };
        return counts;
      } catch {
        return { ran: false, reason: 'pass-error' };
      }
    },
  };
}
