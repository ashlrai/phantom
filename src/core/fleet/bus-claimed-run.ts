/**
 * Compose the exclusive bus work lease with one explicit argv execution.
 * The claim token proves ownership to the claim store only; it never leaves
 * this module (never printed, never accepted from callers) and is not itself
 * authority — the literal argv is the action boundary, message contents are
 * untrusted data, and routing labels authenticate nobody.
 *
 * Ownership loss cannot undo work an already-running child performed, but it
 * stops the child promptly: once renewal or settlement stops proving the
 * lease, this module aborts the runner's signal, freezes the claim (never
 * completing, never releasing a successor owner's row) and reports the loss
 * distinctly. Prompt termination bounds further work yet cannot retract
 * external effects already made, so nothing here implies exactly-once
 * external effects.
 */
import { dirname, isAbsolute } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope, validateBusEnvelope } from './bus-envelope.js';
import type { BusInboxOptions } from './bus-inbox.js';
import { mutateBusWorkClaim, validBusClaimRequest } from './bus-work-claims.js';
import { runContextReply, type ContextReplyResult } from './context-result-bus.js';
import type { ContextWorkerIO, ContextWorkerOptions } from './context-worker-run.js';

export interface BusClaimedRunOptions extends ContextWorkerOptions {
  requestFile: string;
  replyId: string;
  owner: string;
  leaseMs: number;
}

export interface BusClaimedRunClaim {
  /** Terminal store status, refusal, 'invalid' input, or 'ownership-lost'. */
  status: string;
  /** The store status that proved ownership loss — or 'expired' when retryable
   * refusals outlived the last confirmed lease horizon. */
  detail?: string;
  /** Last lease horizon the store confirmed, for observability only. */
  leaseUntil?: number;
}

export interface BusClaimedRunResult {
  claim: BusClaimedRunClaim;
  workerExit: ContextReplyResult['workerExit'];
  replyReceipt: { status: string };
  /** Zero only when the worker returned zero, the reply was delivered, and the claim completed. */
  exitCode: number;
}

export async function runBusClaimedWork(opts: BusClaimedRunOptions, io: ContextWorkerIO = {},
  bus: BusInboxOptions = {}): Promise<BusClaimedRunResult> {
  const root = bus.root;
  const done = (claim: BusClaimedRunClaim, workerExit: BusClaimedRunResult['workerExit'],
    receipt: string, exitCode: number): BusClaimedRunResult =>
    ({ claim, workerExit, replyReceipt: { status: receipt }, exitCode });
  const notStarted = { status: 'not-started' as const };
  const invalid = (): BusClaimedRunResult => done({ status: 'invalid' }, notStarted, 'not-attempted', 2);

  // Validate every input before claiming: absolute NUL-free paths, a non-empty
  // literal argv, a bounded stable request envelope, and a distinct valid reply id.
  if (!isAbsolute(opts.snapshot) || !isAbsolute(opts.prompt) || !isAbsolute(opts.requestFile) ||
      [opts.snapshot, opts.prompt, opts.requestFile].some(path => path.includes('\0')) ||
      !opts.argv.length || opts.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !opts.argv[0] ||
      (opts.signal !== undefined && !(opts.signal instanceof AbortSignal))) return invalid();
  let requestId: string;
  try {
    const read = readStableRegularFile(opts.requestFile, { anchorPath: dirname(opts.requestFile),
      maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
    if (!read.ok || read.text.includes('\ufffd')) return invalid();
    const checked = parseBusEnvelope(read.text);
    if (!checked.ok) return invalid();
    if (opts.replyId === checked.value.id || !validateBusEnvelope({ ...checked.value, id: opts.replyId }).ok) return invalid();
    requestId = checked.value.id;
  } catch { return invalid(); }
  if (!validBusClaimRequest({ action: 'acquire', id: requestId, owner: opts.owner, leaseMs: opts.leaseMs, root })) return invalid();

  // Claim before any launch: refused, expired, completed or conflicting claims spawn nothing.
  const acquired = mutateBusWorkClaim({ action: 'acquire', id: requestId, owner: opts.owner, leaseMs: opts.leaseMs, root });
  if (acquired.status !== 'acquired' || !acquired.token || acquired.leaseUntil === undefined) {
    return done({ status: acquired.status === 'acquired' ? 'unavailable' : acquired.status }, notStarted, 'not-attempted', 1);
  }
  const token = acquired.token;
  let leaseUntil = acquired.leaseUntil;

  // Renew on a bounded interval while the child runs. Only a proven renewal or
  // a transient lock refusal keeps the lease alive; anything else freezes it
  // and aborts the child so no worker keeps acting under a successor's claim.
  // A caller-supplied signal is composed in rather than silently dropped.
  let lost: string | undefined;
  const controller = new AbortController();
  const signal = opts.signal === undefined ? controller.signal
    : AbortSignal.any([controller.signal, opts.signal]);
  const timer = setInterval(() => {
    const renew = mutateBusWorkClaim({ action: 'renew', id: requestId, token, root });
    if (renew.status === 'renewed') {
      if (renew.leaseUntil !== undefined) leaseUntil = renew.leaseUntil;
      return;
    }
    // A refused renewal is survivable only while the last confirmed horizon
    // still holds; past it the lease is dead whatever the store would answer.
    if (renew.status === 'retryable' && Date.now() < leaseUntil) return;
    lost ??= renew.status === 'retryable' ? 'expired' : renew.status;
    clearInterval(timer);
    controller.abort();
  }, Math.max(1, Math.floor(opts.leaseMs / 3)));
  timer.unref();

  let result: ContextReplyResult;
  try {
    result = await runContextReply({ ...opts, signal }, io, bus);
  } catch {
    result = { workerExit: notStarted, replyReceipt: { status: 'unavailable' }, exitCode: 1, reply: null };
  } finally {
    clearInterval(timer);
  }

  // Ownership already proven lost: never complete, never release a successor's
  // row, and report the loss distinctly from worker and publication outcomes.
  if (lost !== undefined) {
    return done({ status: 'ownership-lost', detail: lost, leaseUntil }, result.workerExit, result.replyReceipt.status, result.exitCode || 1);
  }
  // A swapped request file must not complete a claim on a different request id.
  const replyBody = result.reply?.body;
  const bound = !result.reply || (typeof replyBody === 'object' && replyBody !== null && !Array.isArray(replyBody) &&
    (replyBody as Record<string, unknown>).inReplyTo === requestId);
  const delivered = result.replyReceipt.status === 'posted' || result.replyReceipt.status === 'duplicate';
  const succeeded = result.workerExit.status === 'returned' && result.workerExit.exitCode === 0 && delivered && bound;
  // Settle once: complete only while ownership remains and every step succeeded;
  // release for any other owned outcome so the request can be retried later.
  const action = succeeded ? 'complete' : 'release';
  const settle = mutateBusWorkClaim({ action, id: requestId, token, root });
  const terminal = succeeded ? 'completed' : 'released';
  const claim = settle.status === terminal
    ? { status: terminal, leaseUntil }
    : { status: 'ownership-lost', detail: settle.status, leaseUntil };
  return done(claim, result.workerExit, result.replyReceipt.status,
    succeeded && settle.status === 'completed' ? 0 : result.exitCode || 1);
}
