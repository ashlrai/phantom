/** Explicit argv authorizes execution; bus addresses and bodies do not. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Writable } from 'node:stream';
import { validBusWaitClaimRequest, waitClaimBusWork, type BusWaitClaimRequest } from './bus-wait-claim.js';
import { mutateBusWorkClaim } from './bus-work-claims.js';
import { runContextReply } from './context-result-bus.js';
import type { ContextWorkerOptions } from './context-worker-run.js';

export interface BusWorkLoopOptions extends BusWaitClaimRequest, ContextWorkerOptions { maxJobs: number }
export interface BusWorkLoopResult { status: 'invalid' | 'timeout' | 'cancelled' | 'max-jobs' | 'failed'; completed: number }

function validCwd(cwd: unknown): boolean {
  if (cwd === undefined) return true;
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !isAbsolute(cwd)) return false;
  try { return statSync(cwd).isDirectory(); } catch { return false; }
}

export function validBusWorkLoopOptions(opts: BusWorkLoopOptions): boolean {
  return validBusWaitClaimRequest(opts) && Number.isSafeInteger(opts.maxJobs) && opts.maxJobs >= 1 && opts.maxJobs <= 16 &&
    validCwd(opts.cwd) &&
    (opts.timeoutMs === undefined || (Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs >= 1 && opts.timeoutMs <= 3600000)) &&
    [opts.snapshot, opts.prompt].every(p => typeof p === 'string' && isAbsolute(p) && !p.includes('\0')) &&
    Array.isArray(opts.argv) && opts.argv.length > 0 && !!opts.argv[0] &&
    opts.argv.every(a => typeof a === 'string' && !a.includes('\0'));
}

/** Sequential bounded consumer. Ownership loss cannot undo a running child. */
export async function runBusWorkLoop(opts: BusWorkLoopOptions): Promise<BusWorkLoopResult> {
  let completed = 0;
  const done = (status: BusWorkLoopResult['status']): BusWorkLoopResult => ({ status, completed });
  if (!validBusWorkLoopOptions(opts)) return done('invalid');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    while (completed < opts.maxJobs) {
      const acquired = await waitClaimBusWork(opts, controller.signal);
      if (acquired.status !== 'acquired' || !('receipt' in acquired)) {
        return done(acquired.status === 'timeout' ? 'timeout' : acquired.status === 'cancelled' ? 'cancelled' : 'failed');
      }
      const { receipt, token } = acquired;
      const id = receipt.envelope.id, root = opts.root;
      // Cancellation can race a successful acquisition; release without launching.
      if (controller.signal.aborted) {
        mutateBusWorkClaim({ action: 'release', id, token, root });
        return done('cancelled');
      }
      let directory: string | undefined, lost = false, leaseUntil = acquired.leaseUntil;
      let succeeded = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        directory = mkdtempSync(join(tmpdir(), 'phantom-bus-work-'));
        const requestFile = join(directory, 'request.json');
        writeFileSync(requestFile, JSON.stringify(receipt.envelope), { mode: 0o600, flag: 'wx' });
        let replyId: string;
        do { replyId = randomUUID(); } while (replyId === id);
        timer = setInterval(() => {
          const renewal = mutateBusWorkClaim({ action: 'renew', id, token, root });
          if (renewal.status === 'renewed' && renewal.leaseUntil !== undefined) leaseUntil = renewal.leaseUntil;
          else if (renewal.status !== 'retryable' || Date.now() >= leaseUntil) lost = true;
          if (lost && timer) clearInterval(timer);
        }, Math.max(1, Math.floor(opts.leaseMs / 3)));
        timer.unref();
        // The child may echo its input or emit arbitrary text; discard both streams.
        const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const result = await runContextReply({ snapshot: opts.snapshot, prompt: opts.prompt, argv: opts.argv, requestFile, replyId,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) },
          { stdout: sink, stderr: sink }, { root });
        succeeded = result.workerExit.status === 'returned' && result.workerExit.exitCode === 0 &&
          (result.replyReceipt.status === 'posted' || result.replyReceipt.status === 'duplicate') &&
          !!result.reply && typeof result.reply.body === 'object' && result.reply.body !== null &&
          !Array.isArray(result.reply.body) && result.reply.body.inReplyTo === id;
      } catch { succeeded = false; }
      finally {
        if (timer) clearInterval(timer);
        if (directory) {
          try { rmSync(directory, { recursive: true, force: true }); } catch { succeeded = false; }
        }
      }
      if (lost || Date.now() >= leaseUntil) return done('failed');
      const settled = mutateBusWorkClaim({ action: succeeded ? 'complete' : 'release', id, token, root });
      if (!succeeded || settled.status !== 'completed') return done('failed');
      completed++;
      if (controller.signal.aborted) return done('cancelled');
    }
    return done('max-jobs');
  } catch { return done('failed'); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
