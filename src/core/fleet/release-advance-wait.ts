import { setTimeout as delay } from 'node:timers/promises';
import { advanceReleaseCandidate, type ReleaseAdvanceReport } from './release-advance.js';
import { advanceReleaseCandidateOnce, type ReleaseAdvanceOnceReport } from './release-advance-once.js';
import type { GitRunner } from '../verse/git-ops.js';

export type WaitStop = 'attested' | 'published' | 'planned' | 'blocked' | 'refused' | 'unavailable' | 'timeout' | 'aborted';
/** Serialized-dispatch truth from the once lock path; the advance evidence stays in `latest`. */
export type WaitSerialization = Pick<ReleaseAdvanceOnceReport, 'outcome' | 'reason' | 'lock' | 'receipt'>;
export interface ReleaseAdvanceWaitReport {
  version: 1;
  stopReason: WaitStop;
  observations: number;
  latest: ReleaseAdvanceReport | null;
  actionInFlight: boolean;
  /** The mutating observation's once-lock outcome — busy, already-submitted,
   * receipt state — or null when the wait never applied. */
  serialization: WaitSerialization | null;
}
type Action = typeof advanceReleaseCandidate;
export interface WaitOptions {
  apply?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  runner?: GitRunner;
  action?: Action;
  /** Test seam: the per-candidate once state root; production resolves it under ASHLR_HOME. */
  stateDir?: string;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_POLL_MS = 60_000;
export function validWaitDuration(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

interface Observation {
  once: ReleaseAdvanceOnceReport | null;
  evidence: ReleaseAdvanceReport | null;
}

/** Serial observations; only the first may delegate the dispatch, and only
 * through the shared once lock so concurrent --apply supervisors cannot
 * double-submit during GitHub's run-list lag. */
export async function waitForReleaseAdvance(repo: string, tag: string, opts: WaitOptions = {}): Promise<ReleaseAdvanceWaitReport> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  if (!validWaitDuration(timeoutMs, MAX_TIMEOUT_MS) || !validWaitDuration(pollMs, MAX_POLL_MS)) {
    throw new RangeError('Invalid timeout or poll interval');
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const action = opts.action ?? advanceReleaseCandidate;
  const deadline = now() + timeoutMs;
  let latest: ReleaseAdvanceReport | null = null;
  let serialization: WaitSerialization | null = null;
  let observations = 0;
  const finish = (stopReason: WaitStop, actionInFlight = false): ReleaseAdvanceWaitReport =>
    ({ version: 1, stopReason, observations, latest, actionInFlight, serialization });
  while (true) {
    if (opts.signal?.aborted) return finish('aborted');
    if (observations && now() >= deadline) return finish('timeout');
    // The mutating call — and only it — runs inside advanceReleaseCandidateOnce's
    // per-candidate lock. A busy or fail-closed result never falls back to an
    // unguarded dispatch; every other observation stays read-only.
    const mutating = observations === 0 && opts.apply === true;
    const call: Promise<Observation> = mutating
      ? advanceReleaseCandidateOnce(repo, tag, {
        apply: true, runner: opts.runner, stateDir: opts.stateDir, advance: action, now,
      }).then(once => ({ once, evidence: once.advance }))
      : action(repo, tag, { apply: false, runner: opts.runner }).then(evidence => ({ once: null, evidence }));
    // The existing action has no cancellation API. Return on deadline or abort,
    // but report an unfinished action explicitly; never start another read.
    const remaining = Math.max(1, deadline - now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<'timeout' | 'aborted'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), remaining);
      onAbort = () => resolve('aborted');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
    });
    let result: Observation | 'timeout' | 'aborted';
    try {
      result = await Promise.race([call, interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    }
    if (typeof result === 'string') return finish(result, true);
    if (result.once !== null) {
      const { outcome, reason, lock, receipt } = result.once;
      serialization = { outcome, reason, lock, receipt };
    }
    if (result.evidence !== null) latest = result.evidence;
    observations++;
    if (latest?.release.state === 'published') return finish('published');
    if (latest?.attestedRun) return finish('attested');
    if (latest !== null && (latest.outcome === 'blocked' || latest.outcome === 'refused' || latest.outcome === 'unavailable')) {
      return finish(latest.outcome);
    }
    // Fail-closed serialized observations — unreadable receipt, unsafe lock
    // storage, invalid target, a thrown advance — end the wait. A busy lock
    // does not: the dispatch belongs to the lock holder and this waiter only
    // watches real release and attestation progress from here.
    if (result.once !== null && result.once.advance === null && result.once.outcome !== 'busy') return finish('unavailable');
    if (opts.signal?.aborted) return finish('aborted');
    if (now() >= deadline) return finish('timeout');
    // A proposed dispatch is terminal only if there was no prior submission or pending run.
    if (result.once === null && latest?.outcome === 'planned' && observations === 1) return finish('planned');
    try {
      await sleep(Math.min(pollMs, deadline - now()), opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) return finish('aborted');
      throw error;
    }
  }
}
