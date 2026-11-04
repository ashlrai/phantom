import { performance } from 'node:perf_hooks';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { readUsageResets, type UsageResetRow } from './usage-reset-detect.js';
import { scrubPrivateText } from '../util/scrub.js';

export const RESET_AWAIT_MAX_TIMEOUT_MS = 86_400_000;
export const RESET_AWAIT_MAX_POLL_MS = 3_600_000;
export type ResetAwaitOutcome = 'observed' | 'deadline' | 'cancelled' | 'failed';
export interface ResetAwaitResult {
  v: 1; authority: 'none'; outcome: ResetAwaitOutcome; lane: string; checks: number;
  evidence: { sourceState: 'healthy' | 'degraded' | 'missing'; state: UsageResetRow['state'] | null;
    heldBy: 'autobackoff' | 'manual' | null; readingAsOf: string | null } | null;
}
export interface ResetAwaitDeps {
  read?: typeof readUsageResets;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A watermark is a full RFC 3339 timestamp carrying its own offset. */
const RESET_AWAIT_WATERMARK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Epoch ms for a strict RFC 3339 timestamp (explicit timezone, finite date), else null. */
export function parseResetAwaitWatermarkMs(value: string): number | null {
  if (!RESET_AWAIT_WATERMARK_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read-only evidence: neither the result nor a detected reset releases a hold. */
export async function awaitResetEvidence(options: { lane: string; timeoutMs: number; pollMs?: number;
  runsDir?: string; signal?: AbortSignal; after?: string }, deps: ResetAwaitDeps = {}): Promise<ResetAwaitResult> {
  const { lane, timeoutMs, pollMs = 60_000, runsDir, signal, after } = options;
  const result: ResetAwaitResult = { v: 1, authority: 'none', outcome: 'deadline',
    lane: scrubPrivateText(lane, { emails: true }), checks: 0, evidence: null };
  if (!isAwaitMs(timeoutMs, RESET_AWAIT_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, RESET_AWAIT_MAX_POLL_MS)) {
    result.outcome = 'failed'; return result;
  }
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const wallNow = deps.wallNow ?? Date.now;
  // A caller-persisted `after` watermark becomes the exclusive lower evidence
  // boundary, so a reset observed while the supervisor was offline still
  // counts. Default stays invocation time. Both bounds are validated before
  // the first read; this never releases a hold or reads free quota into
  // elapsed time.
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
      const read = await bounded(() => (deps.read ?? readUsageResets)({ runsDir }), deadline - now());
      if (controller.signal.aborted) { result.outcome = 'cancelled'; break; }
      if (now() >= deadline || read.kind === 'deadline') break;
      if (read.kind !== 'value') { result.outcome = read.kind; break; }
      result.checks++;
      const source = read.value;
      const row = source.rows.find(item => item.lane === lane);
      const timestamp = Date.parse(row?.readingAsOf ?? '');
      const readingAsOf = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
      result.evidence = { sourceState: source.sourceState, state: row?.state ?? null,
        heldBy: row?.heldBy ?? null, readingAsOf };
      if (source.sourceState === 'healthy' && row?.held === true && row.heldBy === 'autobackoff'
          && (row.state === 'reset-detected' || row.state === 'reset-time-passed')
          && timestamp > boundary && timestamp <= wallNow()) {
        result.outcome = 'observed'; break;
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
