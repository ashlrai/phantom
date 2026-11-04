/**
 * Invocation-scoped NDJSON feed of retained needs-you answers. Each poll scans
 * the read-only readNeedsMasonAnswer view once, sequentially, under a single
 * monotonic deadline shared by every requested id. A found answer is emitted
 * the moment its id is read — never held back for the rest of the scan — so
 * answered work can resume while unrelated questions stay open. The feed ends
 * with exactly one terminal record naming the outcome and the ids still
 * pending, in request order. A missing receipt is pending, never proof of
 * resolution; an unavailable read ends the feed with delivered answers kept.
 * It never acks, consumes or writes the bus, installs no process-level
 * handlers, and treats reply text as untrusted display data only.
 */
import { performance } from 'node:perf_hooks';
import type { BusInboxOptions } from './bus-inbox.js';
import {
  NEEDS_MASON_ANSWER_ID, readNeedsMasonAnswer, type NeedsMasonAnswer, type NeedsMasonAnswerResult,
} from './needs-mason-answer.js';
import {
  abortableSleep, isAwaitMs, NEEDS_MASON_AWAIT_DEFAULT_POLL_MS, NEEDS_MASON_AWAIT_MAX_POLL_MS,
  NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS,
} from './needs-mason-answer-await.js';

export const NEEDS_ANSWER_FOLLOW_MAX_IDS = 32;
export const NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS = NEEDS_MASON_AWAIT_MAX_TIMEOUT_MS;
export const NEEDS_ANSWER_FOLLOW_MAX_POLL_MS = NEEDS_MASON_AWAIT_MAX_POLL_MS;
export const NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS = NEEDS_MASON_AWAIT_DEFAULT_POLL_MS;

export type NeedsAnswerFollowOutcome = 'complete' | 'timeout' | 'cancelled' | 'unavailable';
export type NeedsAnswerFollowRecord =
  | { v: 1; type: 'answer'; itemId: string; id: string; cursor: number; receivedAt: number; answer: NeedsMasonAnswer }
  | { v: 1; type: 'end'; outcome: NeedsAnswerFollowOutcome; pending: string[] };

export interface NeedsAnswerFollowOptions extends BusInboxOptions {
  ids: string[];
  timeoutMs: number;
  /** Delay between scans; each sleep is also capped by the time remaining. */
  pollMs?: number;
  signal?: AbortSignal;
}
export interface NeedsAnswerFollowDeps {
  read?: typeof readNeedsMasonAnswer;
  /** Receives each record; a throw or rejection ends the feed as unavailable. */
  emit?: (record: NeedsAnswerFollowRecord) => void | Promise<void>;
  /** Monotonic milliseconds for the shared deadline. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts; must not reject. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface NeedsAnswerFollowResult {
  outcome: NeedsAnswerFollowOutcome | 'invalid';
  /** Requested ids still unanswered when the feed ended, in request order. */
  pending: string[];
}

/** Validated up front so a malformed invocation performs no read at all. */
export function validNeedsAnswerFollow(ids: unknown, timeoutMs: unknown, pollMs: unknown): ids is string[] {
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= NEEDS_ANSWER_FOLLOW_MAX_IDS &&
    new Set(ids).size === ids.length && ids.every(id => NEEDS_MASON_ANSWER_ID.test(id)) &&
    isAwaitMs(timeoutMs, NEEDS_ANSWER_FOLLOW_MAX_TIMEOUT_MS) && isAwaitMs(pollMs, NEEDS_ANSWER_FOLLOW_MAX_POLL_MS);
}

export async function followNeedsMasonAnswers(options: NeedsAnswerFollowOptions,
    deps: NeedsAnswerFollowDeps = {}): Promise<NeedsAnswerFollowResult> {
  const { ids, timeoutMs, pollMs = NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS, signal, ...busOptions } = options;
  if (!validNeedsAnswerFollow(ids, timeoutMs, pollMs)) return { outcome: 'invalid', pending: [] };
  const read = deps.read ?? readNeedsMasonAnswer;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const emit = async (record: NeedsAnswerFollowRecord): Promise<boolean> => {
    try { await deps.emit?.(record); return true; } catch { return false; }
  };
  const deadline = now() + timeoutMs;
  const delivered = new Set<string>();
  const scan = async (): Promise<NeedsAnswerFollowOutcome> => {
    for (;;) {
      if (signal?.aborted) return 'cancelled';
      for (const id of ids) {
        if (delivered.has(id)) continue;
        if (signal?.aborted) return 'cancelled';
        let result: NeedsMasonAnswerResult;
        try { result = read(id, busOptions); } catch { return 'unavailable'; }
        if (result.status === 'found') {
          const record: NeedsAnswerFollowRecord = {
            v: 1, type: 'answer', itemId: id,
            id: result.id, cursor: result.cursor, receivedAt: result.receivedAt, answer: result.answer,
          };
          if (!(await emit(record))) return 'unavailable';
          delivered.add(id);
        } else if (result.status !== 'unknown') return 'unavailable';
      }
      if (delivered.size === ids.length) return 'complete';
      const remaining = deadline - now();
      if (remaining <= 0) return 'timeout';
      await sleep(Math.min(pollMs, remaining), signal);
    }
  };
  const outcome = await scan();
  const pending = ids.filter(id => !delivered.has(id));
  await emit({ v: 1, type: 'end', outcome, pending });
  return { outcome, pending };
}
