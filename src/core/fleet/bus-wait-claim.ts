/** Local coordination only; addresses and owner labels do not grant authority. */
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { claimNextBusWork, type BusNextRequest, type BusNextResult } from './bus-next-claim.js';
import { validBusClaimRequest } from './bus-work-claims.js';

export interface BusWaitClaimRequest extends BusNextRequest { waitMs: number }
export function validBusWaitClaimRequest(request: BusWaitClaimRequest): boolean {
  return Number.isSafeInteger(request.waitMs) && request.waitMs >= 1 && request.waitMs <= 300_000 &&
    validBusClaimRequest({ action: 'acquire', id: request.to, owner: request.owner, leaseMs: request.leaseMs, root: request.root });
}

export async function waitClaimBusWork(request: BusWaitClaimRequest, signal?: AbortSignal): Promise<BusNextResult> {
  if (!validBusWaitClaimRequest(request)) return { status: 'invalid' };
  const deadline = performance.now() + request.waitMs;
  for (;;) {
    if (signal?.aborted) return { status: 'cancelled' };
    const result = claimNextBusWork(request);
    // A successful claim always wins, even if cancellation arrived during the call.
    if (result.status !== 'empty' && result.status !== 'retryable') return result;
    if (signal?.aborted) return { status: 'cancelled' };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: 'timeout' };
    try { await delay(Math.min(250, remaining), undefined, { signal }); }
    catch (error) {
      if (signal?.aborted) return { status: 'cancelled' };
      throw error;
    }
    if (signal?.aborted) return { status: 'cancelled' };
    if (performance.now() >= deadline) return { status: 'timeout' };
  }
}
