import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { readAppsRecoveryInvocations } from './apps-recovery-invocations.js';
import { appsRecoveryVerdict } from './apps-recovery-verdict.js';

export type AppsRecoveryWaitDeps = {
  reader?: typeof readAppsRecoveryInvocations;
  stat?: (path: string) => unknown;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

export async function waitAppsRecovery(options: { root: string; invocation: string; maxAge: number; duration: number; interval: number; stopFile?: string }, deps: AppsRecoveryWaitDeps = {}) {
  const { root, invocation, maxAge, duration, interval, stopFile } = options;
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? Date.now;
  const reader = deps.reader ?? readAppsRecoveryInvocations;
  const stat = deps.stat ?? statSync;
  const stopped = (): boolean => {
    if (!stopFile) return false;
    try { stat(stopFile); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const sleep = deps.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  const start = now(), deadline = start + duration;
  let verdict: ReturnType<typeof appsRecoveryVerdict> | null = null;
  let outcome: 'healthy' | 'terminal' | 'timeout' | 'cancelled' | 'unavailable' | 'stopped' = 'timeout';
  try {
    for (;;) {
      if (controller.signal.aborted) { outcome = 'cancelled'; break; }
      if (now() >= deadline) break;
      try {
        if (stopped()) { outcome = 'stopped'; break; }
        const projection = reader(root);
        verdict = appsRecoveryVerdict(projection, invocation, maxAge, wallNow());
        if (controller.signal.aborted) { outcome = 'cancelled'; break; }
        if (stopped()) { outcome = 'stopped'; break; }
        if (projection.availability !== 'available') { outcome = 'unavailable'; break; }
        if (verdict.verdict === 'healthy' || verdict.verdict === 'terminal') { outcome = verdict.verdict; break; }
      } catch { outcome = 'unavailable'; break; }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const nextPoll = now() + Math.min(interval, remaining);
      while (now() < nextPoll) {
        try {
          await sleep(Math.min(stopFile ? 250 : interval, nextPoll - now()), controller.signal);
          if (controller.signal.aborted) break;
          if (stopFile && now() < deadline && stopped()) { outcome = 'stopped'; break; }
        } catch { if (!controller.signal.aborted) outcome = 'unavailable'; break; }
      }
      if (outcome === 'stopped' || outcome === 'unavailable') break;
    }
    return { v: 1 as const, invocationId: invocation, outcome, elapsedMs: Math.max(0, now() - start), verdict,
      ...(outcome === 'unavailable' ? { message: 'Recovery evidence unavailable' } : {}) };
  } finally {
    deps.signal?.removeEventListener('abort', abort);
  }
}
