/** Finite, opt-in supervision through the existing app-ensure CLI. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { selfCliPrefix, type AppsEnsureChildRunner } from './fleet-apps-ensure.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet app-watch <app> --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--json]';
export interface FleetAppWatchDeps {
  runChild?: AppsEnsureChildRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export async function cmdFleetAppWatch(args: string[], deps: FleetAppWatchDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFinite supervision launches only through app-ensure. Exit 0 on completed duration, 1 on failure or cancellation, 2 on invalid arguments.`);
    return 0;
  }
  const invalid = (): number => { console.error(`error: invalid fleet app-watch arguments\n${usage}`); return 2; };
  const [app, ...flags] = args;
  if (!app || !(FLEET_APPS as readonly string[]).includes(app)) return invalid();
  let duration = 0, interval = 1000, root: string | undefined, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (!['--duration-ms', '--interval-ms', '--root', '--json'].includes(flag) || seen.has(flag)) return invalid();
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const value = flags[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (flag === '--root') { root = value; continue; }
    if (!/^[0-9]{1,9}$/.test(value)) return invalid();
    const n = Number(value);
    if (flag === '--duration-ms') { if (n < 1 || n > 300000) return invalid(); duration = n; }
    else { if (n < 100 || n > 60000) return invalid(); interval = n; }
  }
  if (!duration) return invalid();
  let runChild = deps.runChild;
  if (!runChild) {
    const prefix = selfCliPrefix();
    if (prefix === null) { console.error('fleet app-watch: cannot resolve the ashlr CLI entry'); return 1; }
    runChild = async (argv, options) => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [...prefix, ...argv], {
          encoding: 'utf8', timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
        });
        return { code: 0, stdout };
      } catch { return { code: null, stdout: '' }; }
    };
  }
  const now = deps.now ?? (() => performance.now());
  const start = now(), deadline = start + duration;
  let checks = 0, recoveries = 0;
  let lastObservedState: 'running' | null = null;
  let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
  const signal = deps.signal;
  const sleep = deps.sleep ?? ((ms: number, childSignal: AbortSignal) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    childSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  }));

  // Race even uncooperative injected operations against the wall deadline and cancellation.
  const bounded = async <T>(ms: number, operation: (s: AbortSignal) => Promise<T>): Promise<{ value?: T; stopped: boolean }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    const stopped = new Promise<{ stopped: boolean }>(resolve => { stop = () => { controller.abort(); resolve({ stopped: true }); }; });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) return { stopped: true };
      timer = setTimeout(stop, ms);
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)).then(value => ({ value, stopped: false }), () => ({ stopped: false })), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  };

  while (!signal?.aborted && deadline - now() > 0) {
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) break;
    checks++;
    const result = await bounded(remaining, s => runChild!(['fleet', 'app-ensure', app, '--timeout-ms', String(remaining), ...(root === undefined ? [] : ['--root', root]), '--json'], { timeoutMs: remaining, signal: s }));
    if (signal?.aborted || result.stopped || deadline - now() <= 0) break;
    let report: { app?: unknown; outcome?: unknown; running?: unknown } | null = null;
    try { report = JSON.parse(result.value?.stdout ?? '') as { app?: unknown; outcome?: unknown; running?: unknown } | null; } catch { /* untrusted child output */ }
    if (result.value?.code !== 0 || !report || report.app !== app || report.running !== true || !['running', 'launched'].includes(String(report.outcome))) {
      outcome = 'failed';
      break;
    }
    lastObservedState = 'running';
    if (report.outcome === 'launched') recoveries++;
    const left = deadline - now();
    if (left <= 0) break;
    const pause = await bounded(left, s => sleep(Math.min(interval, left), s));
    if (pause.stopped) break;
    if (signal?.aborted || deadline - now() <= 0) break;
  }
  if (signal?.aborted) outcome = 'cancelled';
  const report = { app, outcome, checks, recoveries, lastObservedState, elapsedMs: Math.max(0, Math.min(duration, Math.floor(now() - start))) };
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else console.log(`${app}: ${outcome}; checks=${checks}, recoveries=${recoveries}, last observed=${lastObservedState ?? 'unknown'}, elapsed=${report.elapsedMs}ms`);
  return outcome === 'completed' ? 0 : 1;
}
