import { performance } from 'node:perf_hooks';
import { LANE_ID_RE } from './runs-lane-targets.js';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { RESET_AWAIT_MAX_POLL_MS, RESET_AWAIT_MAX_TIMEOUT_MS, type ResetAwaitDeps, type ResetAwaitOutcome } from './reset-evidence-await.js';
import { readUsageResets, type UsageResetsV1 } from './usage-reset-detect.js';

export const RESET_GROUP_AWAIT_MAX_LANES = 16;
export interface ResetGroupLaneEvidence {
  lane: string; state: 'reset-detected' | 'reset-time-passed'; heldBy: 'autobackoff'; readingAsOf: string;
}
export interface ResetGroupAwaitResult {
  v: 1; authority: 'none'; outcome: ResetAwaitOutcome; checks: number;
  observed: ResetGroupLaneEvidence[]; pending: string[];
}

/** True for 1-16 distinct lane ids, each in the ledger's own lane-id shape. */
export function isResetGroupLaneList(lanes: readonly string[]): boolean {
  return lanes.length > 0 && lanes.length <= RESET_GROUP_AWAIT_MAX_LANES
    && new Set(lanes).size === lanes.length && lanes.every(lane => LANE_ID_RE.test(lane));
}

/** Split a --lanes value; any empty, padded, or repeated entry rejects the whole list. */
export function parseResetGroupLanes(value: string): string[] | null {
  const lanes = value.split(',');
  return isResetGroupLaneList(lanes) ? lanes : null;
}

/** The single-lane awaiter's criteria, applied per lane to one shared snapshot. */
function resetEvidence(source: UsageResetsV1, lane: string, boundary: number, nowMs: number): ResetGroupLaneEvidence | null {
  const row = source.rows.find(item => item.lane === lane);
  const timestamp = Date.parse(row?.readingAsOf ?? '');
  if (source.sourceState !== 'healthy' || row?.held !== true || row.heldBy !== 'autobackoff'
      || (row.state !== 'reset-detected' && row.state !== 'reset-time-passed')
      || !(timestamp > boundary && timestamp <= nowMs)) return null;
  return { lane, state: row.state, heldBy: 'autobackoff', readingAsOf: new Date(timestamp).toISOString() };
}

/**
 * Wait for fresh reset evidence on every named lane with one usage read per poll.
 * Read-only: nothing here releases a hold, dispatches work, or infers quota from elapsed time.
 * The lanes' first qualifying evidence accumulates across polls, in requested order.
 */
export async function awaitResetGroup(options: { lanes: string[]; timeoutMs: number; pollMs?: number;
  runsDir?: string; signal?: AbortSignal }, deps: ResetAwaitDeps = {}): Promise<ResetGroupAwaitResult> {
  const { lanes, timeoutMs, pollMs = 60_000, runsDir, signal } = options;
  const result: ResetGroupAwaitResult = { v: 1, authority: 'none', outcome: 'deadline', checks: 0, observed: [], pending: [] };
  if (!isResetGroupLaneList(lanes) || !isAwaitMs(timeoutMs, RESET_AWAIT_MAX_TIMEOUT_MS) || !isAwaitMs(pollMs, RESET_AWAIT_MAX_POLL_MS)) {
    result.outcome = 'failed'; return result;
  }
  result.pending = [...lanes];
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const wallNow = deps.wallNow ?? Date.now;
  // Invocation time is the exclusive evidence boundary, matching the single-lane awaiter's default.
  const boundary = wallNow();
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const found = new Map<string, ResetGroupLaneEvidence>();
  // Race each operation against cancellation and the overall deadline, so a stalled read cannot outlive the deadline.
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
      // One shared read per poll: every lane is evaluated against the same snapshot.
      const read = await bounded(() => (deps.read ?? readUsageResets)({ runsDir }), deadline - now());
      if (controller.signal.aborted) { result.outcome = 'cancelled'; break; }
      if (now() >= deadline || read.kind === 'deadline') break;
      if (read.kind !== 'value') { result.outcome = read.kind; break; }
      result.checks++;
      const nowMs = wallNow();
      for (const lane of lanes) {
        const evidence = found.has(lane) ? null : resetEvidence(read.value, lane, boundary, nowMs);
        if (evidence) found.set(lane, evidence);
      }
      result.observed = lanes.flatMap(lane => found.get(lane) ?? []);
      result.pending = lanes.filter(lane => !found.has(lane));
      if (result.pending.length === 0) { result.outcome = 'observed'; break; }
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
