import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope, validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';
import { runContextWorker, type ContextWorkerIO, type ContextWorkerOptions } from './context-worker-run.js';
import { runLocalGate, type LocalGateDeps } from './local-gate.js';

export interface ContextReplyOptions extends ContextWorkerOptions { requestFile: string; replyId: string; check?: { budgetSeconds?: number } }
export interface ContextReplyIO extends ContextWorkerIO { gate?: LocalGateDeps }
export type ContextReplyVerification = 'pass' | 'fail' | 'error' | 'skipped';
export interface ContextReplyResult {
  workerExit: { status: 'returned'; exitCode: number } | { status: 'not-started' };
  replyReceipt: BusInboxPost | { status: 'not-attempted' | 'expired' };
  exitCode: number;
  verification?: ContextReplyVerification;
  /** Retain this exact envelope for publication retries; never rerun the worker. */
  reply: BusEnvelope | null;
}

/** Publish an already prepared envelope without executing anything. Keep its TTL
 * decreasing across retries, while preserving identical wire bytes for bus dedupe.
 * The caller must supply elapsed time since preparation; expired retries refuse.
 */
export function publishContextReply(reply: BusEnvelope, elapsedMs: number, options: BusInboxOptions = {}): ContextReplyResult['replyReceipt'] {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) return { status: 'invalid' };
  if (elapsedMs >= reply.ttl) return { status: 'expired' };
  // Backdate admission so the original wire TTL cannot gain lifetime on retry.
  const now = options.now ?? Date.now;
  try {
    const at = now();
    if (!Number.isSafeInteger(at) || at < elapsedMs) return { status: 'invalid' };
    return appendBusInbox(reply, { ...options, now: () => at - elapsedMs });
  } catch { return { status: 'unavailable' }; }
}

/** Explicit argv alone authorizes launch. Routing labels and process outcomes
 * authenticate nobody and grant no task-completion or merge authority.
 * workerExit is exactly the existing runner's return (including runner failures).
 */
export async function runContextReply(opts: ContextReplyOptions, io: ContextReplyIO = {}, bus: BusInboxOptions = {}): Promise<ContextReplyResult> {
  const started = performance.now();
  let request: BusEnvelope;
  const invalid = (): ContextReplyResult => ({ workerExit: { status: 'not-started' }, replyReceipt: { status: 'not-attempted' }, exitCode: 2, reply: null });
  try {
    if (opts.check !== undefined && (opts.check === null || typeof opts.check !== 'object' || Array.isArray(opts.check) ||
        Object.keys(opts.check).some(key => key !== 'budgetSeconds') ||
        (opts.check.budgetSeconds !== undefined && (typeof opts.check.budgetSeconds !== 'number' ||
          !Number.isFinite(opts.check.budgetSeconds) || opts.check.budgetSeconds <= 0)))) return invalid();
    if (!isAbsolute(opts.requestFile) || opts.requestFile.includes('\0')) return invalid();
    const read = readStableRegularFile(opts.requestFile, { anchorPath: dirname(opts.requestFile),
      maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
    if (!read.ok || read.text.includes('\ufffd')) return invalid();
    const checked = parseBusEnvelope(read.text);
    if (!checked.ok) return invalid();
    request = checked.value;
    // Validate the explicit reply ID before any effects. No request body is used.
    if (opts.replyId === request.id || !validateBusEnvelope({ ...request, id: opts.replyId }).ok) return invalid();
  } catch { return invalid(); }
  const exitCode = await runContextWorker(opts, io);
  const workerExit = { status: 'returned' as const, exitCode };
  let verification: ContextReplyVerification | undefined;
  if (opts.check !== undefined) {
    verification = 'skipped';
    if (exitCode === 0) {
      try {
        // Gate diagnostics stay private, including metric-write warnings.
        verification = (await runLocalGate(opts.check.budgetSeconds, { ...io.gate, warn: () => {} })).verdict;
      } catch { verification = 'error'; }
    }
  }
  const verified = verification === undefined ? {} : { verification };
  const resultCode = exitCode || (verification === undefined || verification === 'pass' ? 0 : 1);
  const ttl = request.ttl - Math.ceil(performance.now() - started);
  if (ttl <= 0) return { workerExit, ...verified, replyReceipt: { status: 'expired' }, exitCode: resultCode || 1, reply: null };
  const checked = validateBusEnvelope({ id: opts.replyId, from: request.to, to: request.from, priority: request.priority, ttl,
    body: { inReplyTo: request.id, kind: 'worker-exit', exitCode, succeeded: resultCode === 0, ...verified } });
  if (!checked.ok) return { workerExit, ...verified, replyReceipt: { status: 'invalid' }, exitCode: resultCode || 1, reply: null };
  const replyReceipt = publishContextReply(checked.value, 0, bus);
  const posted = replyReceipt.status === 'posted' || replyReceipt.status === 'duplicate';
  return { workerExit, ...verified, replyReceipt, exitCode: resultCode || (posted ? 0 : 1), reply: checked.value };
}
