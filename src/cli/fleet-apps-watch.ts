/** Finite supervision of an explicit app group through sequential apps-ensure batches. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { selfCliPrefix, type AppsEnsureChildRunner } from './fleet-apps-ensure.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet apps-watch <app>... --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--json | --jsonl]';
export interface FleetAppsWatchDeps {
  runChild?: AppsEnsureChildRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export async function cmdFleetAppsWatch(args: string[], deps: FleetAppsWatchDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFinite supervision delegates launch and refusal decisions to apps-ensure.`);
    return 0;
  }
  const invalid = (): number => { console.error(`error: invalid fleet apps-watch arguments\n${usage}`); return 2; };
  const apps: string[] = [];
  let duration = 0, interval = 1000, root: string | undefined, json = false, jsonl = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (!(FLEET_APPS as readonly string[]).includes(arg)) return invalid();
      if (!apps.includes(arg)) apps.push(arg);
      continue;
    }
    if (!['--duration-ms', '--interval-ms', '--root', '--json', '--jsonl'].includes(arg) || seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (arg === '--jsonl') { jsonl = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') { root = value; continue; }
    if (!/^[0-9]{1,9}$/.test(value)) return invalid();
    const n = Number(value);
    if (arg === '--duration-ms') { if (n < 1 || n > 300000) return invalid(); duration = n; }
    else { if (n < 100 || n > 60000) return invalid(); interval = n; }
  }
  if (!apps.length || !duration || (json && jsonl)) return invalid();
  let runChild = deps.runChild;
  if (!runChild && !deps.signal?.aborted) {
    const prefix = selfCliPrefix();
    if (prefix === null) { console.error('fleet apps-watch: cannot resolve the ashlr CLI entry'); return 1; }
    runChild = async (argv, options) => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [...prefix, ...argv], {
          encoding: 'utf8', timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
        });
        return { code: 0, stdout };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: unknown };
        return { code: typeof e.code === 'number' ? e.code : null, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
      }
    };
  }
  const now = deps.now ?? (() => performance.now());
  const start = now(), wallStart = performance.now();
  const remaining = (): number => Math.max(0, duration - Math.max(0, now() - start, performance.now() - wallStart));
  const signal = deps.signal;
  const sleep = deps.sleep ?? ((ms: number, s: AbortSignal) => new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); s.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    s.addEventListener('abort', done, { once: true });
  }));
  const bounded = async <T>(ms: number, operation: (s: AbortSignal) => Promise<T>): Promise<{ stopped: boolean; value?: T }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    const stopped = new Promise<{ stopped: boolean }>(resolve => { stop = () => { controller.abort(); resolve({ stopped: true }); }; });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted || remaining() <= 0) return { stopped: true };
      timer = setTimeout(stop, ms);
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted || signal?.aborted || remaining() <= 0) return undefined;
        return operation(controller.signal);
      }).then(value => ({ stopped: false, value }), () => ({ stopped: false })), stopped]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  };
  let cycles = 0, recoveries = 0;
  let lastObservedState: { app: string; observedRunning: boolean }[] | null = null;
  let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
  while (!signal?.aborted && remaining() > 0) {
    const budget = Math.ceil(remaining());
    const result = await bounded(budget, s => runChild!(['fleet', 'apps-ensure', ...apps, '--json', ...(root === undefined ? [] : ['--root', root]), '--timeout-ms', String(budget)], { timeoutMs: budget, signal: s }));
    if (signal?.aborted) break;
    if (result.stopped || !result.value || remaining() <= 0) { outcome = 'failed'; break; }
    cycles++;
    let report: { ok?: unknown; apps?: unknown } | null = null;
    try { report = JSON.parse(result.value.stdout) as { ok?: unknown; apps?: unknown } | null; } catch { /* Untrusted child output. */ }
    const rows = report && Array.isArray(report.apps) ? report.apps as Record<string, unknown>[] : [];
    const valid = rows.length === apps.length && rows.every(row => row && typeof row === 'object' && typeof row.app === 'string' && apps.includes(row.app)) && new Set(rows.map(row => row.app)).size === apps.length;
    if (valid) lastObservedState = apps.map(app => ({ app, observedRunning: rows.find(row => row.app === app)!.observedRunning === true }));
    const healthy = result.value.code === 0 && report?.ok === true && valid && rows.every(row => row.observedRunning === true);
    const recovered = healthy ? rows.filter(row => row.launched === true).length : 0;
    recoveries += recovered;
    if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'observation', cycle: cycles, healthy, recoveries: recovered, observedState: valid ? lastObservedState : null })}\n`);
    if (!healthy) { outcome = 'failed'; break; }
    const left = remaining();
    if (left <= 0) break;
    const pause = await bounded(left, s => sleep(Math.min(interval, left), s));
    if (pause.stopped || remaining() <= 0) break;
  }
  if (signal?.aborted) outcome = 'cancelled';
  const summary = { apps, outcome, cycles, recoveries, lastObservedState };
  if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'summary', ...summary })}\n`);
  else if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else console.log(`${apps.join(', ')}: ${outcome}; cycles=${cycles}, recoveries=${recoveries}`);
  return outcome === 'completed' ? 0 : 1;
}
