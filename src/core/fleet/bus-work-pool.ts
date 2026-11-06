/** The shared budget counts one-job attempts, including failures and timeouts.
 * Claim ownership cannot guarantee exactly-once external effects. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runBusWorkLoop, validBusWorkLoopOptions, type BusWorkLoopOptions, type BusWorkLoopResult } from './bus-work-loop.js';

export interface BusWorkPoolOptions extends BusWorkLoopOptions { concurrency: number }
export interface BusWorkPoolResult {
  status: BusWorkLoopResult['status']; completed: number;
  /** quota is the number of attempts reserved by this consumer, not a fixed allocation. */
  consumers: Array<BusWorkLoopResult & { owner: string; quota: number }>;
}

export function validBusWorkPoolOptions(opts: BusWorkPoolOptions): boolean {
  return validBusWorkLoopOptions(opts) && Number.isSafeInteger(opts.concurrency) && opts.concurrency >= 1 && opts.concurrency <= 4;
}

export async function runBusWorkPool(opts: BusWorkPoolOptions): Promise<BusWorkPoolResult> {
  if (!validBusWorkPoolOptions(opts)) return { status: 'invalid', completed: 0, consumers: [] };
  const count = Math.min(opts.concurrency, opts.maxJobs);
  const suffix = randomUUID();
  // Establish the pool's absolute deadline once, before any consumer launches.
  // Only set up a pool budget when no external signal is provided; when an
  // external signal exists, respect its abortion status directly to preserve
  // the existing cancellation semantics (external cancellation stays 'cancelled').
  const hasExternalSignal = opts.signal !== undefined;
  const deadline = (opts.totalTimeoutMs === undefined || hasExternalSignal) ? undefined :
    performance.now() + opts.totalTimeoutMs;
  const budget = deadline === undefined ? undefined : new AbortController();
  const poolTimer = budget === undefined ? undefined :
    setTimeout(() => { budget.abort(); }, opts.totalTimeoutMs!);
  poolTimer?.unref();
  const workers = Array.from({ length: count }, (_, i) => ({
    ...opts, owner: `${opts.owner.slice(0, 88)}-${suffix}-${i + 1}`,
    maxJobs: 1,
  }));
  if (!workers.every(validBusWorkLoopOptions)) return { status: 'invalid', completed: 0, consumers: [] };
  let attempts = 0;
  const consumers = await Promise.all(workers.map(async worker => {
    const consumer: BusWorkLoopResult & { owner: string; quota: number } =
      { owner: worker.owner, quota: 0, status: 'max-jobs', completed: 0 };
    while (attempts < opts.maxJobs) {
      attempts++; consumer.quota++;
      // When no pool budget exists (no totalTimeoutMs, or external signal
      // present), runBusWorkLoop's budget is undefined, preserving current
      // behavior (no deadline). When a pool budget exists, compute the
      // remaining time from the pool's monotonic deadline and pass it.
      const budgetTime = (budget === undefined) ? undefined :
        (budget.signal.aborted ? undefined : Math.max(1, Math.floor(deadline! - performance.now())));
      let result: BusWorkLoopResult;
      try {
        // Pass the pool's budget signal only when there's no external signal;
        // this shares the pool deadline with every running loop without
        // overriding external cancellation semantics.
        const passSignal = hasExternalSignal ? opts.signal : budget?.signal;
        result = await runBusWorkLoop({ ...worker, totalTimeoutMs: budgetTime, signal: passSignal });
      } catch { result = { status: 'failed', completed: 0 }; }
      consumer.completed += result.completed;
      if (result.status !== 'max-jobs') { consumer.status = result.status; break; }
    }
    return consumer;
  }));
  const status = consumers.some(c => c.status === 'failed' || c.status === 'invalid') ? 'failed'
    : consumers.some(c => c.status === 'cancelled') ? 'cancelled'
    : consumers.some(c => c.status === 'timeout') ? 'timeout' : 'max-jobs';
  return { status, completed: consumers.reduce((sum, c) => sum + c.completed, 0), consumers };
}
