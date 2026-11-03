/** Bounded, observe-only polling until a managed app is running or stopped. */

export type AppAwaitTarget = 'running' | 'stopped';
export type AppAwaitOutcome = 'reached' | 'timeout' | 'cancelled' | 'unavailable';

export interface AppAwaitResult {
  outcome: AppAwaitOutcome;
  attempts: number;
  /** Last valid observation; null when no probe ever produced one. */
  running: boolean | null;
  elapsedMs: number;
}

export interface AppAwaitOptions {
  target: AppAwaitTarget;
  timeoutMs: number;
  intervalMs: number;
  /** One status observation; null/throw means unknown. Must honour `budgetMs` as its own timeout. */
  probe: (budgetMs: number) => Promise<boolean | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

type Raced<T> = { kind: 'value'; value: T } | { kind: 'failed' } | { kind: 'deadline' } | { kind: 'aborted' };

/** Real wall timer and abort listener around an injected promise, so a never-settling dependency cannot hang us. */
function race<T>(work: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<Raced<T>> {
  return new Promise(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Raced<T>): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    if (signal?.aborted) return finish({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: 'deadline' }), Math.max(0, ms));
    let p: Promise<T>;
    try { p = Promise.resolve(work()); } catch { return finish({ kind: 'failed' }); }
    // Both handlers swallow, so a late rejection after settle is never unhandled.
    p.then(value => finish({ kind: 'value', value }), () => finish({ kind: 'failed' }));
  });
}

export async function awaitAppState(opts: AppAwaitOptions): Promise<AppAwaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const start = now();
  const deadline = start + opts.timeoutMs;
  const want = opts.target === 'running';
  let attempts = 0;
  let last: boolean | null = null;
  const result = (outcome: AppAwaitOutcome): AppAwaitResult =>
    ({ outcome, attempts, running: last, elapsedMs: Math.max(0, now() - start) });

  for (;;) {
    if (opts.signal?.aborted) return result('cancelled');
    const remaining = deadline - now();
    if (remaining <= 0) return result(last === null ? 'unavailable' : 'timeout');
    attempts++;
    const probed = await race(() => opts.probe(remaining), remaining, opts.signal);
    if (probed.kind === 'aborted') return result('cancelled');
    if (probed.kind === 'deadline') return result(last === null ? 'unavailable' : 'timeout');
    if (probed.kind === 'value' && typeof probed.value === 'boolean') {
      last = probed.value;
      if (last === want) return result('reached');
    }
    const left = deadline - now();
    if (left <= 0) return result(last === null ? 'unavailable' : 'timeout');
    const slept = await race(() => sleep(Math.min(opts.intervalMs, left)), left, opts.signal);
    if (slept.kind === 'aborted') return result('cancelled');
  }
}
