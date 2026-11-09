import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitAppsRecovery, type AppsRecoveryWaitDeps as ServiceDeps } from '../core/fleet/apps-recovery-wait.js';

const usage = 'Usage: ashlr fleet apps-recovery-wait --invocation <v4 uuid> --max-age-ms <positive integer> --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--json]';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type AppsRecoveryWaitDeps = ServiceDeps & { emit?: (line: string) => void };

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
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  try {
    const result = await waitAppsRecovery({ root, invocation, maxAge, duration, interval, stopFile }, { ...deps, signal: controller.signal });
    emit(JSON.stringify(result));
    return result.outcome === 'healthy' ? 0 : 1;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
