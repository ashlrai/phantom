import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readAppsRecoveryInvocations } from '../core/fleet/apps-recovery-invocations.js';
import { appsRecoveryVerdict } from '../core/fleet/apps-recovery-verdict.js';

const usage = 'Usage: ashlr fleet apps-recovery-wait --invocation <v4 uuid> --max-age-ms <positive integer> --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--json]';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type AppsRecoveryWaitDeps = {
  reader?: typeof readAppsRecoveryInvocations;
  stat?: (path: string) => unknown;
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  emit?: (line: string) => void;
};

export async function cmdFleetAppsRecoveryWait(args: string[], deps: AppsRecoveryWaitDeps = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.length === 1 && args[0] === '--help') { emit(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid arguments\n${usage}`); return 2; };
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let stopFile: string | undefined;
  let invocation = '', maxAge = 0, duration = 0, interval = 1000;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--root', '--json', '--invocation', '--max-age-ms', '--duration-ms', '--interval-ms', '--stop-file'].includes(arg) || seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') root = value;
    else if (arg === '--stop-file') stopFile = resolve(value);
    else if (arg === '--invocation') invocation = value;
    else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      const n = Number(value);
      if (arg === '--max-age-ms') maxAge = n;
      else if (arg === '--duration-ms') duration = n;
      else interval = n;
    }
  }
  if (!uuid.test(invocation) || maxAge < 1 || duration < 1 || duration > 300000 || interval < 100 || interval > 60000) return invalid();
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
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
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
    emit(JSON.stringify({ v: 1, invocationId: invocation, outcome, elapsedMs: Math.max(0, now() - start), verdict,
      ...(outcome === 'unavailable' ? { message: 'Recovery evidence unavailable' } : {}) }));
    return outcome === 'healthy' ? 0 : 1;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
