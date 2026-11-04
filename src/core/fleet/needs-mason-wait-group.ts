import { setTimeout as delay } from 'node:timers/promises';
import { NEEDS_WAIT_ID, NEEDS_WAIT_MAX_MS, waitNeedsMason, type NeedsWaitStatus } from './needs-mason-wait.js';

export const NEEDS_WAIT_GROUP_MAX_IDS = 32;
export type NeedsWaitGroupOutcome = NeedsWaitStatus;
export interface NeedsWaitGroupItem { id: string; status: NeedsWaitStatus }
export interface NeedsWaitGroupResult { outcome: NeedsWaitGroupOutcome; items: NeedsWaitGroupItem[] }

export interface NeedsWaitGroupOptions {
  ids: string[]; timeoutMs: number; pollMs: number; runsDir?: string;
  now?: () => number;
  /** Per-child poll sleep, forwarded to waitNeedsMason. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Wall-clock budget timer; resolves when the shared budget is spent. Injectable for tests. */
  budgetSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/** Worst-first aggregate: anything unresolved keeps the group from counting as resolved. */
function aggregate(items: NeedsWaitGroupItem[]): NeedsWaitGroupOutcome {
  if (items.every(i => i.status === 'resolved')) return 'resolved';
  for (const s of ['cancelled', 'timeout', 'unavailable', 'unknown'] as const) if (items.some(i => i.status === s)) return s;
  return 'unavailable';
}

export function validateNeedsWaitGroup(ids: string[], timeoutMs: number, pollMs: number): boolean {
  return ids.length >= 1 && ids.length <= NEEDS_WAIT_GROUP_MAX_IDS && new Set(ids).size === ids.length &&
    ids.every(id => NEEDS_WAIT_ID.test(id)) &&
    [timeoutMs, pollMs].every(n => Number.isSafeInteger(n) && n >= 1 && n <= NEEDS_WAIT_MAX_MS);
}

/** Wait for several needs-you items under one shared wall-clock budget; ordered like `ids`. */
export async function waitNeedsMasonGroup(options: NeedsWaitGroupOptions): Promise<NeedsWaitGroupResult> {
  const { ids, timeoutMs, pollMs } = options;
  if (!validateNeedsWaitGroup(ids, timeoutMs, pollMs)) throw new RangeError('Invalid wait group options');
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  // Every child registers SIGINT/SIGTERM handlers; avoid Node's leak warning for <=32 of them.
  const maxListeners = process.getMaxListeners();
  process.setMaxListeners(maxListeners + ids.length * 2);
  let expired = false;
  const budgetSleep = options.budgetSleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const budget = budgetSleep(timeoutMs, controller.signal).then(
    () => { expired = true; abort(); }, () => undefined);
  try {
    const statuses = await Promise.all(ids.map(async (id): Promise<NeedsWaitStatus> => {
      try {
        const s = await waitNeedsMason({ id, timeoutMs, pollMs, runsDir: options.runsDir, now: options.now, sleep: options.sleep, signal: controller.signal });
        return s === 'cancelled' && expired ? 'timeout' : s;
      } catch { return 'unavailable'; }
    }));
    const items = ids.map((id, i) => ({ id, status: statuses[i]! }));
    return { outcome: aggregate(items), items };
  } finally {
    abort(); // cancel the budget timer and any straggler, then wait for cleanup
    await budget;
    options.signal?.removeEventListener('abort', abort);
    process.setMaxListeners(maxListeners);
  }
}
