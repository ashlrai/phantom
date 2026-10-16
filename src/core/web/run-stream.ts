/**
 * core/web/run-stream.ts — GET /api/run/:id/events: a per-run SSE tail.
 *
 * WHY THIS FILE EXISTS (the honest version):
 *
 * The route tails two distinct durable, bounded sources:
 *   - ~/.ashlr/run-streams/<id>.log receives exact-opt-in, scrubbed and capped
 *     StreamSink events while supported CLI, web, daemon, API-model, and
 *     best-of-N runs execute. It contains engine/model progress at finer
 *     granularity than completed orchestration steps, but is deliberately not
 *     an unredacted transcript or a guarantee that every backend emits token
 *     deltas.
 * By contrast, ~/.ashlr/agent-logs/*.jsonl
 *     (src/core/run/agent-diagnostics.ts) is
 *     metadata-only (byte/line COUNTS, never the text itself — see
 *     AgentDiagnosticTextShape, agent-diagnostics.ts:126-130) and is appended
 *     once per engine attempt, at completion, not during execution.
 *   - RunState.steps[].summary (src/core/types.ts:1928-1939) IS real,
 *     human-readable text, and IS the thing that grows on disk WHILE a run
 *     executes: every task/tool/model/synthesize step appends one entry via
 *     saveRun() (src/core/run/orchestrator.ts:1201, atomic write at :1271),
 *     called at every step-completion boundary (e.g. :3103, :3160, :3168)
 *     AND when a task first transitions to 'running' (:3294-3297, saved at
 *     :3297) — which is a real, disk-persisted "this task just started"
 *     signal that predates its own first step.
 *
 * The second source is ~/.ashlr/runs/<id>.json (loadRun()/saveRun(),
 * orchestrator.ts). Its RunState.steps[].summary grows at task and step
 * boundaries. A "step-output-chunk" is therefore one already-written
 * RunStep.summary, not a model token; the separately named "output-chunk"
 * event is the finer-grained durable stream above. Relative to polling
 * GET /api/run/:id (src/web-ui/components/stream/useRunStream.ts), this route
 * also provides push delivery, a tighter server-side tail interval
 * (RUN_TAIL_POLL_MS, 500ms vs. the client's previous 2000ms / the general SSE
 * route's 1500ms), resumable event-family cursors, and server-computed stall
 * detection.
 *
 * EVENT PROTOCOL
 *   id: <opaque cursor>       present on every resumable event (see below)
 *   event: step-started       a RunTask left 'pending' — {taskId, index, goal}
 *   event: step-output-chunk  a RunStep appended     — {taskId, kind, index, ts, text}
 *   event: step-done          same RunStep, again     — {taskId, kind, index, ts, usage}
 *   event: output-chunk        a line appended to the run's durable stream file
 *                              (~/.ashlr/run-streams/<id>.log, written by
 *                              streaming.ts's fileSink() — see that file's
 *                              header for what feeds it: engine subprocess
 *                              stdout as it arrives, not just at completion,
 *                              plus builtin-task model-delta/tool-call/log
 *                              events) — {taskId, kind, ts, text}. This route
 *                              tails that bounded durable source alongside
 *                              RunState.
 *   event: run-done           RunState.status left 'running' — {status, result, terminationReason};
 *                              the stream ends cleanly right after this frame
 *   event: stall               (no id — not part of the resumable cursor) the
 *                              source hasn't grown in >= RUN_STALL_AFTER_MS — {ageMs}
 *
 * SEQUENCE / RESUME
 * SSE ids are opaque versioned vectors: v1:<task-prefix>:<step-seq>:<output-seq>.
 * Each family advances independently, so a later task start survives both
 * prior step completion and output delivery. Task-prefix records only the
 * contiguous delivered tasks[] prefix; out-of-order starts may replay on a
 * reconnect, preserving every lifecycle event without a persisted event log.
 * Legacy numeric step/output cursors resume their own family and replay the
 * others; legacy task indexes conservatively replay all starts.
 * run-done follows drained durable EOF. stream-gap explicitly declares corrupt,
 * incomplete, or unreadable captured output; the route is observability, not
 * a completeness receipt for the engine transcript.
 *
 * SECURITY
 *  - Read-only. No path traversal: `id` is validated against RUN_ID_RE
 *    (mirrors src/core/run/orchestrator.ts:327's runFilePath() grammar)
 *    BEFORE loadRun() ever builds a path, and again defensively here even
 *    though the caller (api.ts) already matched the same shape via
 *    RUN_EVENTS_PATH_RE.
 *  - Every payload passes through sanitizePublicJson() (src/core/util/
 *    public-json.ts), same as the general SSE route's sendNamed() — this
 *    scrubs secret-shaped substrings (scrubSecrets(), src/core/util/
 *    scrub.ts) AND redacts concrete home-dir paths from every string in the
 *    event, so an engine echoing an env var into a step summary cannot leak
 *    it onto the wire.
 *  - Shares the general SSE route's connection cap (sseConnectionCapReached()
 *    / registerSse() / deregisterSse(), src/core/web/api.ts) — one pool, not
 *    a second unbounded one.
 *  - Streams from the freshly-loaded RunState on each tick (loadRun() reads
 *    the whole small JSON record — MAX_PERSISTED_RUN_BYTES-bounded in
 *    orchestrator.ts) and only ever writes the NEW slice since last tick;
 *    it never slurps or buffers unbounded history growth.
 *  - Auth: identical read-session boundary as every other GET /api/* route
 *    (src/core/web/server.ts, gated before handleApi is even reached), plus
 *    the same EventSource query-proof allowance as /api/events (server.ts's
 *    isSseQueryProofPath()) since a browser EventSource cannot set the
 *    x-ashlr-read-client header.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { RunState } from '../types.js';
import { loadRun } from '../run/orchestrator.js';
import { gcRunStreams, MAX_STREAM_FILE_BYTES, readRunStreamChunkResult, type RunStreamReadIdentity } from '../run/streaming.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { registerSse, deregisterSse, sseConnectionCapReached, sendJson } from './api.js';

// ---------------------------------------------------------------------------
// Route matching / run-id grammar
// ---------------------------------------------------------------------------

/** Mirrors src/core/run/orchestrator.ts:327's runFilePath() validation exactly. */
const RUN_ID_RE = /^[\w.-]{1,200}$/;

/**
 * Matches the full route (used by api.ts's dispatcher to extract the id).
 * Deliberately loose on the id segment — same shape as the existing
 * `path.startsWith('/api/run/')` handling for GET /api/run/:id — so that an
 * id shaped wrong for RUN_ID_RE (traversal attempt, stray characters,
 * percent-encoded slash smuggling, etc.) still reaches handleRunEventsSse()
 * and gets a real, testable 400 there instead of silently 404ing at the
 * router. RUN_ID_RE is the one gate that actually decides safety; this is
 * only routing.
 */
export const RUN_EVENTS_PATH_RE = /^\/api\/run\/([^/]+)\/events$/;

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Tight-but-sane: this is localhost, and the whole point is beating the
 * general SSE route's 1500ms poll floor for a single run the operator is
 * actively watching. */
const RUN_TAIL_POLL_MS = 500;

/** Matches the honesty threshold the client already used when this was
 * poll-only (src/web-ui/components/stream/useRunStream.ts's STALL_AFTER_MS)
 * — moving the computation server-side doesn't mean moving the goalposts. */
const RUN_STALL_AFTER_MS = 8_000;

/** Once stalled, don't re-announce every 500ms tick — repeat at a calmer
 * cadence with a fresh age so the client never needs its own timer to keep
 * the banner's "Ns" text honest. */
const RUN_STALL_REPEAT_MS = 5_000;

/** Fixed, generous ceiling reserved for task-started ids. Step ids are
 * pinned to this base regardless of how many tasks a run ends up with, so a
 * task appearing later can never shift a step id already sent to a client. */
const STEP_SEQ_BASE = 1_000_000;

/** Fixed ceiling reserved for step/task/run-done ids (STEP_SEQ_BASE + up to
 * 2 ids per step). Real runs are budget-capped at dozens of steps
 * (DEFAULT_MAX_STEPS = 40, orchestrator.ts) — this leaves a ~5,000,000-step
 * margin before output-chunk ids could ever collide with a step id, the same
 * "fixed, generous ceiling" reasoning STEP_SEQ_BASE already uses. */
const OUTPUT_SEQ_BASE = 10_000_000;

// ---------------------------------------------------------------------------
// Deterministic sequence numbering
// ---------------------------------------------------------------------------

function taskStartedSeq(taskIndex: number): number {
  return Math.min(taskIndex, STEP_SEQ_BASE - 1);
}

function stepChunkSeq(stepIndex: number): number {
  return STEP_SEQ_BASE + stepIndex * 2;
}

function stepDoneSeq(stepIndex: number): number {
  return STEP_SEQ_BASE + stepIndex * 2 + 1;
}

function runDoneSeq(stepCount: number): number {
  return STEP_SEQ_BASE + stepCount * 2;
}

interface EventFrame {
  seq: number;
  event: string;
  data: unknown;
}

interface ResumeCursor {
  task: number;
  step: number;
  output: number;
}

/** Tasks can start out of array order. Only a contiguous delivered prefix is
 * resumable; later starts may replay after reconnect, but can never hide an
 * earlier pending task. The connection-local set suppresses live duplicates. */
function* newRunEvents(run: RunState, cursor: ResumeCursor, starts: Set<number>): Generator<EventFrame> {
  for (const [i, task] of run.tasks.entries()) {
    if (task.status === 'pending' || i <= cursor.task || starts.has(i)) continue;
    yield { seq: taskStartedSeq(i), event: 'step-started', data: { taskId: task.id, index: i, goal: task.goal } };
  }
  for (const [j, step] of run.steps.entries()) {
    if (stepChunkSeq(j) > cursor.step) yield {
      seq: stepChunkSeq(j), event: 'step-output-chunk',
      data: { taskId: step.taskId, kind: step.kind, index: j, ts: step.ts, text: step.summary },
    };
    if (stepDoneSeq(j) > cursor.step) yield {
      seq: stepDoneSeq(j), event: 'step-done',
      data: { taskId: step.taskId, kind: step.kind, index: j, ts: step.ts, usage: step.usage ?? null },
    };
  }
  if (run.status !== 'running' && runDoneSeq(run.steps.length) > cursor.step) yield {
    seq: runDoneSeq(run.steps.length), event: 'run-done',
    data: { status: run.status, result: run.result ?? null, terminationReason: run.terminationReason ?? null },
  };
}

// ---------------------------------------------------------------------------
// output-chunk tailing — src/core/run/streaming.ts's fileSink() writes one
// JSONL record per persisted chunk to ~/.ashlr/run-streams/<id>.log; this
// section tails that file the same way the rest of this route tails
// RunState: incrementally, never re-reading history it has already sent.
// ---------------------------------------------------------------------------

function outputChunkSeq(lineIndex: number): number {
  return OUTPUT_SEQ_BASE + lineIndex;
}

/**
 * Per-connection tail cursor. `offset` is "bytes of the stream file already
 * read off disk" (monotonic, advances by one bounded chunk per read).
 * `partial` holds a trailing line read but not yet terminated by
 * '\n' at the time it was read, carried into the next call. Neither field is
 * derivable from `lastSeq` alone (a JSONL line's byte length isn't fixed),
 * so — unlike the deterministic array-index math above — this cursor lives
 * for the lifetime of ONE connection and is NOT recomputed from scratch on
 * every tick. It IS recomputed from scratch (offset 0) once, on connection
 * open — a bounded read (the file is capped at MAX_STREAM_FILE_BYTES,
 * streaming.ts) — which is what makes both a fresh connection (full replay)
 * and a reconnect with Last-Event-ID (skip-already-seen via the seq > lastSeq
 * guard below) work through the exact same code path.
 */
interface OutputTailCursor {
  offset: number;
  lineIndex: number;
  partial: string;
  identity?: RunStreamReadIdentity;
  decoder: StringDecoder;
}

function createOutputTailCursor(): OutputTailCursor {
  return { offset: 0, lineIndex: 0, partial: '', decoder: new StringDecoder('utf8') };
}

interface StoredStreamChunkLike {
  ts?: unknown;
  kind?: unknown;
  taskId?: unknown;
  text?: unknown;
}

/** A historical writer may put a whole event in one record. Preserve those
 * records while independently bounding decoder carry by the durable file cap. */
const MAX_OUTPUT_RECORD_CHARS = MAX_STREAM_FILE_BYTES;

function* newOutputChunks(
  runId: string, cursor: OutputTailCursor, lastSeq: number,
): Generator<EventFrame, { eof: boolean; grew: boolean; gap?: string }> {
  const result = readRunStreamChunkResult(runId, cursor.offset, cursor.identity);
  const chunk = result.chunk;
  if (!chunk) return { eof: true, grew: false, gap: result.reason === 'stream-missing' && !cursor.identity ? undefined : result.reason };
  cursor.identity = chunk.identity;
  if (chunk.bytes.length === 0) return { eof: chunk.eof, grew: false };
  cursor.offset = chunk.nextOffset;
  const text = cursor.partial + cursor.decoder.write(chunk.bytes);
  const lines = text.split('\n');
  cursor.partial = lines.pop() ?? '';
  if (cursor.partial.length > MAX_OUTPUT_RECORD_CHARS) throw new Error('output record exceeds replay bound');
  for (const line of lines) {
    const seq = outputChunkSeq(cursor.lineIndex++);
    if (seq <= lastSeq) continue;
    if (line.length > MAX_OUTPUT_RECORD_CHARS) throw new Error('output record exceeds replay bound');
    let parsed: StoredStreamChunkLike | null = null;
    try { parsed = JSON.parse(line) as StoredStreamChunkLike; } catch { /* declared gap below */ }
    if (!parsed || typeof parsed.text !== 'string' || typeof parsed.kind !== 'string') {
      yield { seq, event: 'stream-gap', data: { reason: 'invalid-output-record' } };
      continue;
    }
    yield { seq, event: 'output-chunk', data: {
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
      kind: parsed.kind, ts: typeof parsed.ts === 'string' ? parsed.ts : new Date().toISOString(), text: parsed.text,
    } };
  }
  return { eof: chunk.eof, grew: true };
}

// ---------------------------------------------------------------------------
// Growth / stall detection
// ---------------------------------------------------------------------------

interface ProgressSnapshot {
  startedTasks: number;
  steps: number;
  status: RunState['status'];
  updatedAt: string;
}

function progressOf(run: RunState): ProgressSnapshot {
  return {
    startedTasks: run.tasks.filter((t) => t.status !== 'pending').length,
    steps: run.steps.length,
    status: run.status,
    updatedAt: run.updatedAt,
  };
}

function progressEqual(a: ProgressSnapshot, b: ProgressSnapshot): boolean {
  return (
    a.startedTasks === b.startedTasks
    && a.steps === b.steps
    && a.status === b.status
    && a.updatedAt === b.updatedAt
  );
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function singleHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? (raw[0] ?? '') : '';
  return raw ?? '';
}

function parseLastEventId(req: IncomingMessage): ResumeCursor {
  const raw = singleHeader(req, 'last-event-id');
  const empty = { task: -1, step: -1, output: -1 };
  const fields = /^v1:(-?\d+):(-?\d+):(-?\d+)$/.exec(raw);
  if (fields) {
    const [task, step, output] = fields.slice(1).map(Number);
    if ([task, step, output].every((n) => Number.isSafeInteger(n) && n! >= -1) &&
      task! < STEP_SEQ_BASE && step! < OUTPUT_SEQ_BASE) return { task: task!, step: step!, output: output! };
    return empty;
  }
  // Legacy scalar ids identify only one family. Replay the others rather
  // than treating their smaller ids as already delivered.
  const n = Number(raw);
  if (!raw || !Number.isSafeInteger(n) || n < -1) return empty;
  if (n >= OUTPUT_SEQ_BASE) empty.output = n;
  else if (n >= STEP_SEQ_BASE) empty.step = n;
  // A legacy task index cannot prove lower pending indexes were delivered.
  // Conservatively replay task starts when migrating that scalar cursor.
  return empty;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle GET /api/run/:id/events. Synchronous entry point (loadRun() is
 * synchronous); the SSE lifecycle itself is driven by a bounded poll timer,
 * torn down on run completion, client disconnect, or server shutdown (via
 * the shared registerSse()/drainSseConnections() registry in api.ts).
 */
export function handleRunEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
  readSession: { id: string; expiresAt: number },
): void {
  const id = rawId;
  if (!RUN_ID_RE.test(id)) {
    sendJson(res, 400, { error: 'invalid run id' });
    return;
  }

  // A read is also a maintenance path: expire stale/over-budget captures now,
  // even when the system never produces another durable output write.
  gcRunStreams(true);

  const initial = loadRun(id);
  if (!initial) {
    sendJson(res, 404, { error: `run not found: ${id}` });
    return;
  }

  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const cursor = parseLastEventId(req);
  const starts = new Set<number>();
  const outputCursor = createOutputTailCursor();
  let lastProgress = progressOf(initial);
  let lastGrowthAt = Date.now();
  let stallLastEmitAt: number | null = null;
  let ended = false;
  let busy = false;
  let waitingForDrain: (() => void) | undefined;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearInterval(intervalId);
    clearTimeout(expiryTimer);
    deregisterSse(sseId);
    waitingForDrain?.();
    req.off('close', finish);
    req.off('error', finish);
    res.off('close', finish);
    res.off('error', finish);
    try { res.end(); } catch { /* Already ended. */ }
  };

  /** write(false) accepted the frame: advance its cursor once, then wait.
   * No queued replay frames accumulate while a client is applying pressure. */
  const write = async (line: string): Promise<void> => {
    if (ended) return;
    if (res.write(line) || ended) return;
    await new Promise<void>((resolve) => {
      const drained = (): void => {
        res.off('drain', drained);
        waitingForDrain = undefined;
        resolve();
      };
      waitingForDrain = drained;
      res.once('drain', drained);
    });
  };

  const send = async ({ seq, event, data }: EventFrame): Promise<void> => {
    if (ended) return;
    if (event === 'step-started') {
      starts.add(seq);
      while (starts.delete(cursor.task + 1)) cursor.task++;
    } else if (seq >= OUTPUT_SEQ_BASE) cursor.output = seq;
    else cursor.step = seq;
    await write(`id: v1:${cursor.task}:${cursor.step}:${cursor.output}\nevent: ${event}\ndata: ${JSON.stringify(sanitizePublicJson(data))}\n\n`);
  };

  const tick = async (): Promise<void> => {
    if (ended || busy) return;
    busy = true;
    try {
      const fresh = loadRun(id);
      if (!fresh) return;
      let grew = false;
      // Each read/allocation is bounded; yielding between reads prevents a
      // full 8MiB replay from monopolizing the server's event loop.
      while (!ended) {
        const chunks = newOutputChunks(id, outputCursor, cursor.output);
        let next = chunks.next();
        while (!next.done && !ended) {
          await send(next.value);
          next = chunks.next();
        }
        if (ended || !next.done) return;
        grew ||= next.value.grew;
        if (next.value.gap) await write(`event: stream-gap\ndata: ${JSON.stringify({ reason: next.value.gap })}\n\n`);
        if (next.value.eof) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (ended) return;
      if (fresh.status !== 'running' && (outputCursor.partial || outputCursor.decoder.end())) {
        await write('event: stream-gap\ndata: {"reason":"incomplete-output-record"}\n\n');
        outputCursor.partial = '';
      }
      for (const frame of newRunEvents(fresh, cursor, starts)) {
        if (ended) return;
        await send(frame);
      }
      const progress = progressOf(fresh);
      if (grew || !progressEqual(progress, lastProgress)) {
        lastProgress = progress;
        lastGrowthAt = Date.now();
        stallLastEmitAt = null;
      } else if (fresh.status === 'running') {
        const now = Date.now();
        const ageMs = now - lastGrowthAt;
        if (ageMs >= RUN_STALL_AFTER_MS && (stallLastEmitAt === null || now - stallLastEmitAt >= RUN_STALL_REPEAT_MS)) {
          await write(`event: stall\ndata: ${JSON.stringify({ ageMs })}\n\n`);
          stallLastEmitAt = now;
        }
      }
      if (fresh.status !== 'running') finish();
    } catch {
      // A replay failure is visible; never claim that missing output drained.
      if (!ended) {
        try { await write('event: stream-gap\ndata: {"reason":"replay-failed"}\n\n'); } catch { /* Socket failed. */ }
      }
      finish();
    } finally { busy = false; }
  };

  req.on('close', finish);
  req.on('error', finish);
  res.on('close', finish);
  res.on('error', finish);
  const sseId = registerSse(finish, readSession.id);
  const expiryTimer = setTimeout(finish, Math.max(0, readSession.expiresAt - Date.now()));
  const intervalId = setInterval(() => { void tick(); }, RUN_TAIL_POLL_MS);
  // The comment is smaller than the socket's normal high-water mark; replay
  // itself always checks the write return value and waits for drain.
  try { res.write(': connected\n\n'); } catch { finish(); return; }
  void tick();
}
