/** The shared budget counts one-job attempts, including failures and timeouts.
 * Claim ownership cannot guarantee exactly-once external effects. */
import { randomUUID } from 'node:crypto';
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
  const workers = Array.from({ length: count }, (_, i) => ({
    ...opts, owner: `${opts.owner.slice(0, 88)}-${suffix}-${i + 1}`,
    maxJobs: 1,
  }));
  // Validate every derived option before any loop can acquire a claim.
  if (!workers.every(validBusWorkLoopOptions)) return { status: 'invalid', completed: 0, consumers: [] };
  let attempts = 0;
  const consumers = await Promise.all(workers.map(async worker => {
    const consumer: BusWorkLoopResult & { owner: string; quota: number } =
      { owner: worker.owner, quota: 0, status: 'max-jobs', completed: 0 };
    while (attempts < opts.maxJobs) {
      // Reserve synchronously, before the loop can yield or another consumer can start.
      attempts++; consumer.quota++;
      let result: BusWorkLoopResult;
      try { result = await runBusWorkLoop(worker); }
      catch { result = { status: 'failed', completed: 0 }; }
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
