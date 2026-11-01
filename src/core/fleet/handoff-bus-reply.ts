/**
 * Answer one live worker-handoff envelope with a durable worker-exit reply.
 * Same trust boundary as handoff-receive: the retained envelope is untrusted
 * data, its scrubbed prompt is staged privately and reaches the child only on
 * stdin inside the existing context reply delivery runner. Only the caller's
 * explicit argv executes — nothing is claimed, completed or merged. A failed
 * publication is durably spooled so context-deliver/context-drain retries
 * republish the exact envelope without rerunning the worker.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  BUS_INBOX_MAX_MESSAGES,
  BUS_INBOX_MAX_READ,
  listBusInboxAfter,
  type BusInboxOptions,
  type BusInboxReceipt,
} from './bus-inbox.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubPrivateText } from '../util/scrub.js';
import { isFleetJobId } from './runs-job-detail.js';
import { HANDOFF_RECEIVE_BEGIN, HANDOFF_RECEIVE_END } from './handoff-bus-receive.js';
import {
  runContextReplyDelivery,
  type ContextDeliverRunResult,
  type ContextDeliveryOutcome,
} from './context-reply-spool.js';
import type { ContextWorkerIO } from './context-worker-run.js';

/** Bounded scan of the durable inbox, the same page cap the receiver uses. */
const MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const TIMEOUT_MAX_MS = 3600000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));
/** Same printable-ASCII token rule the envelope applies to id/from/to. */
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);

interface WorkerHandoffBody { taskId: string; prompt: string }

/** Exact body schema emitted by `ashlr fleet handoff-send --apply`. */
function isWorkerHandoffBody(body: unknown): body is WorkerHandoffBody {
  return record(body) && keys(body, ['kind', 'taskId', 'prompt']) &&
    body.kind === 'worker-handoff' &&
    typeof body.taskId === 'string' && isFleetJobId(body.taskId) &&
    typeof body.prompt === 'string' && body.prompt.trim().length > 0;
}

type Found = { status: 'ok'; receipt: BusInboxReceipt }
  | { status: 'unavailable' | 'not-found' | 'ambiguous' };

/** Exactly one live receipt for `id`, paged through the bounded inbox reader. */
function findLiveReceipt(id: string, options: BusInboxOptions): Found {
  const matches: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options);
    if (result.status !== 'ok') return { status: 'unavailable' };
    for (const row of result.messages) {
      if (row.envelope.id === id) matches.push(row);
    }
    if (!Number.isSafeInteger(result.nextCursor) || result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  if (matches.length > 1) return { status: 'ambiguous' };
  return matches.length === 1
    ? { status: 'ok', receipt: matches[0]! }
    : { status: 'not-found' };
}

/** Check and retain the same snapshot bytes that the worker runner will read. */
function matchingSnapshot(path: string, taskId: string): string | null {
  const read = readStableRegularFile(path, {
    anchorPath: dirname(path),
    maxFileBytes: SNAPSHOT_MAX_BYTES,
    remainingBytes: SNAPSHOT_MAX_BYTES,
  });
  if (!read.ok) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (!record(parsed) || !record(parsed.node) || parsed.node.jobId !== taskId) return null;
    return read.text;
  } catch {
    return null;
  }
}

export interface HandoffBusReplyOptions {
  /** Envelope id to locate in the local inbox. */
  id: string;
  /** The exact address the retained envelope must be addressed to. */
  to: string;
  /** Absolute path to a NodeContextPackInput JSON whose node.jobId equals the body taskId. */
  snapshot: string;
  /** Fresh id for the worker-exit reply; must differ from the handoff id. */
  replyId: string;
  /** Absolute private directory that retains a reply whose publication failed. */
  spoolDir: string;
  /** Bounded worker runtime in milliseconds, forwarded to the runner unchanged. */
  timeoutMs: number;
  argv: readonly string[];
}

export interface HandoffBusReplyResult {
  workerExit: ContextDeliverRunResult['workerExit'];
  /** The runner's delivery outcome, or 'refused' when preflight stopped it. */
  delivery: ContextDeliveryOutcome | { status: 'refused' };
  exitCode: number;
}

/**
 * Refuse ambiguous, expired, misaddressed or incomplete data before staging,
 * then let runContextReplyDelivery run the worker once and durably publish
 * the worker-exit reply routed request.to -> request.from, preserving the
 * request's provenance and remaining TTL. Diagnostics never echo retained
 * prompt, task, routing or body text.
 */
export async function replyHandoffBus(opts: HandoffBusReplyOptions,
  options: BusInboxOptions = {}, io: ContextWorkerIO = {}): Promise<HandoffBusReplyResult> {
  const stderr = io.stderr ?? process.stderr;
  const refuse = (text: string, exitCode: number): HandoffBusReplyResult => {
    stderr.write(`handoff-reply: ${text}\n`);
    return { workerExit: { status: 'not-started' }, delivery: { status: 'refused' }, exitCode };
  };
  if (!token(opts.id) || !token(opts.to) || !token(opts.replyId) ||
      !isAbsolute(opts.snapshot) || opts.snapshot.includes('\0') ||
      !isAbsolute(opts.spoolDir) || opts.spoolDir.includes('\0') ||
      !Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > TIMEOUT_MAX_MS ||
      !opts.argv[0] || opts.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    return refuse('invalid input', 2);
  }
  let found: Found;
  try {
    found = findLiveReceipt(opts.id, options);
  } catch {
    found = { status: 'unavailable' };
  }
  if (found.status === 'unavailable') return refuse('bus inbox unavailable', 1);
  if (found.status !== 'ok') {
    return refuse(found.status === 'ambiguous' ? 'ambiguous handoff id' : 'no live handoff with that id', 1);
  }
  const envelope = found.receipt.envelope;
  if (envelope.to !== opts.to) return refuse('handoff is not addressed to this recipient', 1);
  if (!isWorkerHandoffBody(envelope.body)) return refuse('unexpected handoff body', 1);
  if (opts.replyId === envelope.id) return refuse('reply id must differ from the handoff id', 1);
  const { taskId, prompt } = envelope.body;
  const snapshot = matchingSnapshot(opts.snapshot, taskId);
  if (snapshot === null) {
    return refuse('snapshot unavailable or does not match the handoff task', 1);
  }
  // Canonical request bytes preserve provenance and the remaining TTL the
  // bounded reader already decremented; the runner subtracts worker time.
  const checked = validateBusEnvelope(envelope);
  if (!checked.ok) return refuse('handoff envelope is not canonical', 1);
  const dir = await mkdtemp(join(resolve(tmpdir()), 'phm-handoff-reply-')).catch(() => '');
  if (!dir) return refuse('temporary workspace unavailable', 1);
  try {
    try {
      await writeFile(join(dir, 'request.json'), checked.json, { mode: 0o600 });
      await writeFile(join(dir, 'prompt.txt'),
        HANDOFF_RECEIVE_BEGIN + scrubPrivateText(prompt, { emails: true }) + HANDOFF_RECEIVE_END,
        { mode: 0o600 });
      await writeFile(join(dir, 'snapshot.json'), snapshot, { mode: 0o600 });
    } catch {
      return refuse('temporary workspace unavailable', 1);
    }
    const result = await runContextReplyDelivery({
      snapshot: join(dir, 'snapshot.json'),
      prompt: join(dir, 'prompt.txt'),
      requestFile: join(dir, 'request.json'),
      replyId: opts.replyId,
      spoolDir: opts.spoolDir,
      timeoutMs: opts.timeoutMs,
      argv: [...opts.argv],
    }, io, options);
    return { workerExit: result.workerExit, delivery: result.delivery, exitCode: result.exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
