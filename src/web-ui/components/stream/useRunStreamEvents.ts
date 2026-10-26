/**
 * components/stream/useRunStreamEvents.ts — the SSE transport half of live
 * run streaming. Opens one EventSource per mounted run against
 * `GET /api/run/:id/events` (src/core/web/run-stream.ts) and exposes the
 * frames it receives.
 *
 * This hook does NOT reconstruct a full RunState from events — the server
 * event protocol intentionally carries only the new slice per tick (see
 * run-stream.ts's header comment for exactly why: RunStep.summary is the
 * finest real granularity available without engine changes, there is no
 * token stream). The full structured run (steps/tasks/usage/status) still
 * comes from the existing GET /api/run/:id query cache; useRunStream.ts
 * composes this hook with that query, using SSE frames as a push-triggered
 * refetch signal instead of useRunStream's old fixed 2s poll, and using the
 * server's own `stall` events instead of client-inferred staleness.
 *
 * Fallback contract: if the endpoint doesn't exist (older server — 404/400/
 * 503 before the connection ever reaches 'open'), or EventSource itself
 * isn't available, `status` settles to 'unavailable' and the caller is
 * expected to fall back to polling. It never retries forever against a
 * route that plainly isn't there.
 */
import { useEffect, useState } from 'react';
import { getReadClientProof } from '../../data/auth-store.js';

export interface RunStreamChunk {
  taskId: string;
  kind: string;
  index: number;
  ts: string;
  text: string;
}

/**
 * v333: a line from the run's durable stream file (streaming.ts's
 * fileSink()) — live engine subprocess output / builtin model-delta text as
 * it happened, not just a step boundary. No `index` (there's no stable array
 * position the way RunStep has one — the server derives its seq from the
 * stream file's line position instead, see run-stream.ts's
 * newOutputChunks). `taskId` is often absent: whole-goal engine
 * delegation and sandboxed runs have no per-task concept.
 */
export interface RunStreamOutputChunk {
  taskId: string | null;
  kind: string;
  ts: string;
  text: string;
}

export interface RunStreamTaskStarted {
  taskId: string;
  index: number;
  goal: string;
}

export interface RunStreamDoneEvent {
  status: 'done' | 'failed' | 'aborted';
  result: string | null;
  terminationReason: string | null;
}

export type SseTransportStatus = 'connecting' | 'open' | 'reconnecting' | 'complete' | 'unavailable';

/** A lost response may reconnect, but cannot claim a complete capture forever. */
export const RUN_STREAM_RECONNECT_TIMEOUT_MS = 30_000;

export interface RunStreamEventsState {
  status: SseTransportStatus;
  chunks: RunStreamChunk[];
  /** v333: live output-chunk frames tailed from the durable stream file —
   * see RunStreamOutputChunk. Append-only for the life of this mount. */
  outputChunks: RunStreamOutputChunk[];
  starts: RunStreamTaskStarted[];
  stall: { ageMs: number; at: number } | null;
  runDone: RunStreamDoneEvent | null;
  gap: { reason: string } | null;
  /** Increments on every received frame — a cheap effect dependency for
   * "something changed, go refetch the structured run now". */
  version: number;
}

const INITIAL_STATE: RunStreamEventsState = {
  status: 'connecting',
  chunks: [],
  outputChunks: [],
  starts: [],
  stall: null,
  runDone: null,
  gap: null,
  version: 0,
};

function parseEventData<T>(evt: Event): T | null {
  const messageEvent = evt as MessageEvent<string>;
  try {
    return JSON.parse(messageEvent.data) as T;
  } catch {
    return null;
  }
}

/** Decode only the output coordinate at the protocol edge for replay dedupe.
 * Cursor ids remain opaque outside this transport. Never use payload.seq: the
 * server's payload has no such field, and another family can change its id. */
function outputCoordinate(evt: Event): number | null {
  const raw = (evt as MessageEvent<string>).lastEventId;
  if (typeof raw !== 'string' || raw.length > 96) return null;
  const vector = /^v1:(-?\d+):(-?\d+):(-?\d+)$/.exec(raw);
  const seq = vector ? Number(vector[3]) : /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(seq) && seq >= 10_000_000 ? seq : null;
}

function validDone(data: RunStreamDoneEvent | null): data is RunStreamDoneEvent {
  return data !== null && ['done', 'failed', 'aborted'].includes(data.status) &&
    (data.result === null || typeof data.result === 'string') &&
    (data.terminationReason === null || typeof data.terminationReason === 'string');
}

/** Terminal runs also open this route to replay their available capture. */
export function useRunStreamEvents(runId: string, enabled: boolean): RunStreamEventsState {
  const [state, setState] = useState<RunStreamEventsState>(INITIAL_STATE);

  useEffect(() => { setState(INITIAL_STATE); }, [runId]);

  useEffect(() => {
    if (!enabled) return;
    setState(INITIAL_STATE);
    if (typeof EventSource === 'undefined') {
      setState((s) => ({ ...s, status: 'unavailable', gap: { reason: 'stream-unavailable' } }));
      return;
    }

    const url = `/api/run/${encodeURIComponent(runId)}/events?client=${encodeURIComponent(getReadClientProof())}`;
    const source = new EventSource(url, { withCredentials: true });
    const starts = new Set<string>();
    const chunks = new Set<number>();
    const dones = new Set<number>();
    let lastOutput = -1;
    let opened = false;
    let settled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners: Array<[string, EventListener]> = [];
    const on = (event: string, listener: EventListener): void => {
      listeners.push([event, listener]);
      source.addEventListener(event, listener);
    };
    const clearReconnect = (): void => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    const unavailable = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearReconnect();
      source.close();
      setState((s) => ({ ...s, status: 'unavailable', gap: s.gap ?? { reason }, version: s.version + 1 }));
    };

    source.onopen = () => {
      if (settled) return;
      opened = true;
      clearReconnect();
      setState((s) => ({ ...s, status: 'open' }));
    };
    source.onerror = () => {
      if (settled) return;
      if (!opened || source.readyState === 2) {
        unavailable(opened ? 'stream-interrupted' : 'stream-unavailable');
        return;
      }
      setState((s) => ({ ...s, status: 'reconnecting' }));
      // Native EventSource can stay CONNECTING after a server closes without
      // run-done, including session expiry. Bound that wait, preserving chunks.
      reconnectTimer ??= setTimeout(() => unavailable('reconnect-timeout'), RUN_STREAM_RECONNECT_TIMEOUT_MS);
    };

    on('step-started', (evt) => {
      if (settled) return;
      const data = parseEventData<RunStreamTaskStarted>(evt);
      if (!data || typeof data.taskId !== 'string' || !Number.isSafeInteger(data.index) || data.index < 0 || typeof data.goal !== 'string') return;
      const key = `${data.index}:${data.taskId}`;
      if (starts.has(key)) return;
      starts.add(key);
      setState((s) => ({ ...s, starts: [...s.starts, data], version: s.version + 1 }));
    });
    on('step-output-chunk', (evt) => {
      if (settled) return;
      const data = parseEventData<RunStreamChunk>(evt);
      if (!data || !Number.isSafeInteger(data.index) || data.index < 0 || typeof data.text !== 'string') return;
      if (chunks.has(data.index)) return;
      chunks.add(data.index);
      setState((s) => ({ ...s, chunks: [...s.chunks, data], version: s.version + 1 }));
    });
    on('step-done', (evt) => {
      if (settled) return;
      const data = parseEventData<{ index: number }>(evt);
      if (!data || !Number.isSafeInteger(data.index) || data.index < 0 || dones.has(data.index)) return;
      dones.add(data.index);
      setState((s) => ({ ...s, stall: null, version: s.version + 1 }));
    });
    on('output-chunk', (evt) => {
      if (settled) return;
      const data = parseEventData<RunStreamOutputChunk>(evt);
      if (!data || typeof data.text !== 'string' || typeof data.kind !== 'string' || typeof data.ts !== 'string') return;
      const seq = outputCoordinate(evt);
      if (seq !== null && seq <= lastOutput) return;
      if (seq !== null) lastOutput = seq;
      setState((s) => ({ ...s, outputChunks: [...s.outputChunks, data], version: s.version + 1 }));
    });
    on('stall', (evt) => {
      if (settled) return;
      const data = parseEventData<{ ageMs: number }>(evt);
      if (!data || !Number.isFinite(data.ageMs) || data.ageMs < 0) return;
      setState((s) => ({ ...s, stall: { ageMs: data.ageMs, at: Date.now() }, version: s.version + 1 }));
    });
    on('stream-gap', (evt) => {
      if (settled) return;
      const data = parseEventData<{ reason: string }>(evt);
      const reason = data && typeof data.reason === 'string' ? data.reason : 'invalid-gap-event';
      setState((s) => ({ ...s, gap: { reason }, version: s.version + 1 }));
    });
    on('run-done', (evt) => {
      if (settled) return;
      const data = parseEventData<RunStreamDoneEvent>(evt);
      if (!validDone(data)) { unavailable('invalid-run-done'); return; }
      settled = true;
      clearReconnect();
      source.close();
      setState((s) => ({ ...s, status: 'complete', runDone: data, stall: null, version: s.version + 1 }));
    });

    return () => {
      settled = true;
      clearReconnect();
      source.onopen = null;
      source.onerror = null;
      for (const [event, listener] of listeners) source.removeEventListener(event, listener);
      source.close();
    };
  }, [runId, enabled]);

  return state;
}
