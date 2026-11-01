/** Fixed quotas bound total work; failed consumers leave their unused quota behind.
 * Claim ownership cannot guarantee exactly-once external effects. */
import { randomUUID } from 'node:crypto';
import { runBusWorkLoop, validBusWorkLoopOptions, type BusWorkLoopOptions, type BusWorkLoopResult } from './bus-work-loop.js';

export interface BusWorkPoolOptions extends BusWorkLoopOptions { concurrency: number }
export interface BusWorkPoolResult {
  status: BusWorkLoopResult['status']; completed: number;
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
    maxJobs: Math.floor(opts.maxJobs / count) + (i < opts.maxJobs % count ? 1 : 0),
  }));
  // Validate every derived option before any loop can acquire a claim.
  if (!workers.every(validBusWorkLoopOptions)) return { status: 'invalid', completed: 0, consumers: [] };
  const results = await Promise.allSettled(workers.map(worker => runBusWorkLoop(worker)));
  const consumers = results.map((result, i) => ({ owner: workers[i]!.owner, quota: workers[i]!.maxJobs,
    ...(result.status === 'fulfilled' ? result.value : { status: 'failed' as const, completed: 0 }) }));
  const status = consumers.some(c => c.status === 'failed' || c.status === 'invalid') ? 'failed'
    : consumers.some(c => c.status === 'cancelled') ? 'cancelled'
    : consumers.some(c => c.status === 'timeout') ? 'timeout' : 'max-jobs';
  return { status, completed: consumers.reduce((sum, c) => sum + c.completed, 0), consumers };
}
