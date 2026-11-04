import { performance } from 'node:perf_hooks';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { parseResetAwaitWatermarkMs } from './reset-evidence-await.js';
import { readResetReleases, type ResetReleaseRecord } from './usage-reset-release.js';
import { scrubPrivateText } from '../util/scrub.js';

export const RESET_RELEASE_AWAIT_MAX_TIMEOUT_MS = 86_400_000;
export const RESET_RELEASE_AWAIT_MAX_POLL_MS = 3_600_000;
export type ResetReleaseAwaitOutcome = 'recorded' | 'deadline' | 'cancelled' | 'failed';
export interface ResetReleaseAwaitResult {
  v: 1; authority: 'none'; outcome: ResetReleaseAwaitOutcome; lane: string; checks: number;
  release: { timestamp: string; state: ResetReleaseRecord['state'] } | null;
}
export interface ResetReleaseAwaitDeps {
  read?: typeof readResetReleases;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Wait for the audit log to prove a lane-hold release, not for fresh reset
 * evidence. reset-evidence-await resolves the moment the detector reads a
 * healthy fresh reset; the release loop can still fail to act on it, so a
 * supervisor that stopped there would resume work while the hold still stood.
 * This resolves 'recorded' only once queue/reset-releases.jsonl carries an
 * audit line for the exact lane stamped strictly after invocation (or after a
 * caller-persisted `after` watermark) and no later than the current wall
 * clock — older, unparsable or future-dated lines never
 * satisfy it. 'recorded' is audit evidence only: it is not a verdict on
 * present lane health or successful dispatch, and this module never releases
 * a hold or launches work.
 */
export async function awaitResetRelease(options: { lane: string; timeoutMs: number; pollMs?: number;
  runsDir?: string; signal?: AbortSignal; after?: string }, deps: ResetReleaseAwaitDeps = {}): Promise<ResetReleaseAwaitResult> {
  const { lane, timeoutMs, pollMs = 60_000, runsDir, signal, after } = options;
  const result: ResetReleaseAwaitResult = { v: 1, authority: 'none', outcome: 'deadline',
    lane: scrubPrivateText(lane, { emails: true }), checks: 0, release: null };
  if (!isAwaitMs(timeoutMs, RESET_RELEASE_AWAIT_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, RESET_RELEASE_AWAIT_MAX_POLL_MS)) {
    result.outcome = 'failed'; return result;
  }
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const wallNow = deps.wallNow ?? Date.now;
  // A caller-persisted `after` watermark becomes the exclusive lower audit
  // boundary, so a release recorded while the supervisor was offline still
  // counts. Default stays invocation time. Both bounds are validated before
  // the first read; this never releases a hold or launches work.
  let boundary = wallNow();
  if (after !== undefined) {
    const parsed = parseResetAwaitWatermarkMs(after);
    if (parsed === null) { result.outcome = 'failed'; return result; }
    boundary = parsed;
  }
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  // Race each operation against both cancellation and the remaining deadline.
  // Promise.race attaches rejection handlers even to a reader that finishes late.
  const bounded = async <T>(operation: () => Promise<T>, limit: number): Promise<
    { kind: 'value'; value: T } | { kind: 'deadline' | 'cancelled' | 'failed' }> => {
    const timer = new AbortController();
    let onAbort: () => void = () => {};
    const cancelled = new Promise<{ kind: 'cancelled' }>(resolve => {
      onAbort = () => resolve({ kind: 'cancelled' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      return await Promise.race([
        Promise.resolve().then(operation).then(value => ({ kind: 'value' as const, value }), () => ({ kind: 'failed' as const })),
        sleep(limit, timer.signal).then(() => ({ kind: 'deadline' as const }), () => ({ kind: 'failed' as const })),
        cancelled,
      ]);
    } finally { timer.abort(); controller.signal.removeEventListener('abort', onAbort); }
  };
  try {
    while (!controller.signal.aborted && now() < deadline) {
      const read = await bounded(() => (deps.read ?? readResetReleases)(runsDir, 200), deadline - now());
      if (controller.signal.aborted) { result.outcome = 'cancelled'; break; }
      if (now() >= deadline || read.kind === 'deadline') break;
      if (read.kind !== 'value') { result.outcome = read.kind; break; }
      result.checks++;
      const wall = wallNow();
      const match = read.value.find(item => {
        if (item.lane !== lane) return false;
        const at = Date.parse(item.at);
        return Number.isFinite(at) && at > boundary && at <= wall;
      });
      if (match) {
        result.outcome = 'recorded';
        result.release = { timestamp: new Date(Date.parse(match.at)).toISOString(), state: match.state };
        break;
      }
      const wait = await bounded(() => sleep(Math.min(pollMs, deadline - now()), controller.signal), deadline - now());
      if (controller.signal.aborted) { result.outcome = 'cancelled'; break; }
      if (wait.kind === 'failed') { result.outcome = 'failed'; break; }
      if (wait.kind === 'deadline' || now() >= deadline) break;
    }
    if (controller.signal.aborted) result.outcome = 'cancelled';
  } catch { result.outcome = 'failed'; }
  finally {
    controller.abort(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
  }
  return result;
}
