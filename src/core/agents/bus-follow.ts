/**
 * `agents bus follow`: a bounded streaming watch over one agent's addressed
 * inbox — the same `readAgentInbox` projection `agents bus inbox` serves,
 * emitted as JSONL message and checkpoint records, so an agent on the unified
 * surface watches for new mail without dropping to `fleet bus-follow`'s
 * raw-envelope stream or polling `inbox` in a loop. Read-only local
 * observation; routing labels are data, never authenticated identity, and
 * bodies are never executed.
 */
import { performance } from 'node:perf_hooks';
import {
  BUS_FOLLOW_DEFAULT_INTERVAL_MS, BUS_FOLLOW_MAX_DURATION_MS,
  BUS_FOLLOW_MAX_INTERVAL_MS, BUS_FOLLOW_MIN_INTERVAL_MS,
} from '../fleet/bus-follow-stream.js';
import { BUS_INBOX_MAX_READ } from '../fleet/bus-inbox.js';
import type { BusPriority } from '../fleet/bus-envelope.js';
import {
  busBodyFallbackSummary, busBodySummary, readAgentInbox,
  type InboxKind, type InboxMessage, type UnifiedBusOptions,
} from './bus-unified.js';
import type { WorkResultOutcome } from './bus-v2-schema.js';

/** The `readAgentInbox` page filters a follow stream applies, minus the paging fields. */
export interface AgentBusFollowFilters {
  /** Keep only `note`/`context` bodies carrying that v2 thread label. */
  thread?: string;
  /** Keep only mail one sender identity wrote — handle, `agent:` address, stable id or alias. */
  from?: string;
  /** Drop mail sent under every registered spelling of one identity; composes with `from`. */
  excludeFrom?: string;
  /** Keep only the two-way exchange the addressed agent and one peer name. */
  with?: string;
  /** Keep only envelopes stamped with that exact P0..P3 band. */
  priority?: BusPriority;
  /** Keep only one delivery kind — `dm`, `channel`, `handoff` or `legacy`. */
  kind?: InboxKind;
  /** Keep only mail naming one job under the shared `busBodyJobMatch` citation rule. */
  job?: string;
  /** Keep only mail received at or after this epoch-ms cutoff. */
  since?: number;
  /** Keep only mail received strictly before this epoch-ms cutoff. */
  before?: number;
  /** Keep only mail addressed to `group:<name>:*` of one registry channel the agent belongs to. */
  channel?: string;
  /** Keep only mail whose scrubbed one-line summary carries the needle. */
  contains?: string;
  /** Keep only mail whose object body cites that envelope id through its own `inReplyTo`. */
  inReplyTo?: string;
  /** Keep only the row whose own wire id is strictly equal. */
  id?: string;
  /** Keep only mail whose body carries that exact kind discriminator. */
  bodyKind?: string;
  /** Keep only `work.result` bodies whose own outcome strictly equals this code. */
  result?: WorkResultOutcome;
}

export interface AgentBusFollowRequest extends AgentBusFollowFilters {
  /** Identity ref the stream watches — a handle, `agent:<handle>`, stable id or alias. */
  agent: string;
  /** Resume cursor: only rows scanned after it emit. Default 0 replays retained mail. */
  after?: number;
  /** Bounded lifetime is mandatory: 1..BUS_FOLLOW_MAX_DURATION_MS milliseconds. */
  durationMs: number;
  /** Poll interval; default BUS_FOLLOW_DEFAULT_INTERVAL_MS, bounded by the shared stream limits. */
  intervalMs?: number;
}

/** One emitted inbox row: the `readAgentInbox` projection plus its rendered summary. */
export interface AgentBusFollowMessage extends InboxMessage {
  type: 'message';
  /** The same scrubbed one-line summary the `--frame` read renders — never the raw body. */
  summary: string;
}

export type AgentBusFollowRecord =
  | AgentBusFollowMessage
  | { type: 'checkpoint'; cursor: number };

export type AgentBusFollowStatus =
  | 'expired' | 'cancelled' | 'source-unavailable' | 'output-unavailable' | 'invalid' | 'unknown-agent';

export interface AgentBusFollowResult {
  status: AgentBusFollowStatus;
  /** Greatest cursor the output stream accepted: the safe at-least-once resume point. */
  cursor: number;
  /** Message records accepted by the output stream. */
  delivered: number;
  elapsedMs: number;
}

export interface AgentBusFollowDeps {
  /** Resolves when the record is accepted by the output stream; throws or rejects on failure. */
  emit: (record: AgentBusFollowRecord) => void | Promise<void>;
  /** Page reader; defaults to `readAgentInbox`. Injectable for tests. */
  read?: typeof readAgentInbox;
  /** Interval sleeper; defaults to a signal-aware wait. Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Monotonic millisecond clock for the deadline (defaults to performance.now). */
  clock?: () => number;
}

/** Printable ASCII routing labels — the same agent-ref grammar `work mine` validates. */
const AGENT_REF = /^[\x21-\x7e]{1,128}$/;

export function validAgentBusFollowRequest(request: AgentBusFollowRequest): boolean {
  return typeof request.agent === 'string' && AGENT_REF.test(request.agent) &&
    (request.after === undefined || (Number.isSafeInteger(request.after) && request.after >= 0)) &&
    Number.isSafeInteger(request.durationMs) && request.durationMs >= 1 && request.durationMs <= BUS_FOLLOW_MAX_DURATION_MS &&
    (request.intervalMs === undefined || (Number.isSafeInteger(request.intervalMs) &&
      request.intervalMs >= BUS_FOLLOW_MIN_INTERVAL_MS && request.intervalMs <= BUS_FOLLOW_MAX_INTERVAL_MS));
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Polls `readAgentInbox` until the duration expires, emitting each matching
 * row once in the page's own priority-then-cursor order and a checkpoint
 * whenever the scan position advances. A checkpoint is offered only after
 * every preceding message record was accepted, so the returned cursor is
 * always a safe at-least-once resume point. `retryable` pages pause one
 * interval and re-read; `unavailable` fails the stream as
 * `source-unavailable`; `invalid` and `unknown-agent` are deterministic and
 * end it immediately. A page that fills its row cap re-polls without
 * sleeping so a retained backlog drains inside the same deadline.
 */
export async function followAgentBus(
  request: AgentBusFollowRequest,
  options: UnifiedBusOptions = {},
  deps: AgentBusFollowDeps,
): Promise<AgentBusFollowResult> {
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const elapsed = (): number => Math.max(0, Math.floor(clock() - started));
  if (!validAgentBusFollowRequest(request) || typeof deps.emit !== 'function') {
    return { status: 'invalid', cursor: 0, delivered: 0, elapsedMs: elapsed() };
  }
  const deadline = started + request.durationMs;
  const interval = request.intervalMs ?? BUS_FOLLOW_DEFAULT_INTERVAL_MS;
  const read = deps.read ?? readAgentInbox;
  const sleep = deps.sleep ?? wait;
  const emit = async (record: AgentBusFollowRecord): Promise<boolean> => {
    try { await deps.emit(record); return true; } catch { return false; }
  };
  const aborted = (): boolean => deps.signal?.aborted === true;
  const pause = (): Promise<void> => sleep(Math.max(0, Math.min(interval, deadline - clock())), deps.signal);
  const filters: AgentBusFollowFilters = {
    thread: request.thread, from: request.from, excludeFrom: request.excludeFrom, with: request.with,
    priority: request.priority, kind: request.kind, job: request.job, since: request.since,
    before: request.before, channel: request.channel, contains: request.contains,
    inReplyTo: request.inReplyTo, id: request.id, bodyKind: request.bodyKind, result: request.result,
  };
  let cursor = request.after ?? 0, delivered = 0, status: AgentBusFollowStatus = 'expired';
  try {
    for (;;) {
      if (aborted()) { status = 'cancelled'; break; }
      if (clock() >= deadline) break;
      const page = read(request.agent, { after: cursor, limit: BUS_INBOX_MAX_READ, ...filters }, options);
      if (aborted()) { status = 'cancelled'; break; }
      if (page.status === 'retryable') { await pause(); continue; }
      if (page.status === 'unknown-agent') { status = 'unknown-agent'; break; }
      if (page.status === 'invalid') { status = 'invalid'; break; }
      if (page.status !== 'ok') { status = 'source-unavailable'; break; }
      let accepted = true;
      for (const message of page.messages) {
        const record: AgentBusFollowMessage = { type: 'message', ...message,
          summary: busBodySummary(message.envelope.body) ?? busBodyFallbackSummary(message.envelope.body) };
        if (!(await emit(record))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          accepted = false;
          break;
        }
        delivered += 1;
      }
      if (!accepted) break;
      const advanced = page.nextCursor > cursor;
      if (advanced) {
        const next = page.nextCursor;
        if (!(await emit({ type: 'checkpoint', cursor: next }))) {
          status = aborted() ? 'cancelled' : 'output-unavailable';
          break;
        }
        cursor = next;
      }
      // A full page means more matches may sit just past the scan position;
      // re-poll without sleeping so a backlog drains inside the deadline. A
      // short page means the bounded scan reached the store tail, so wait.
      if (page.messages.length === BUS_INBOX_MAX_READ && advanced) continue;
      await pause();
    }
  } catch { status = 'source-unavailable'; }
  if (status === 'expired' && !(await emit({ type: 'checkpoint', cursor }))) status = 'output-unavailable';
  return { status, cursor, delivered, elapsedMs: elapsed() };
}
