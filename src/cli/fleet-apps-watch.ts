/** Finite supervision of an explicit app group through sequential apps-ensure batches. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createAppsWatchPublisher, type AppsWatchEvent } from '../core/fleet/apps-watch-bus.js';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { selfCliPrefix, type AppsEnsureChildRunner } from './fleet-apps-ensure.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet apps-watch <app>... --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--max-consecutive-failures <1..10>] [--max-recoveries <1..1000>] [--bus] [--json | --jsonl]';
export interface FleetAppsWatchDeps {
  runChild?: AppsEnsureChildRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  createBusPublisher?: typeof createAppsWatchPublisher;
}

export async function cmdFleetAppsWatch(args: string[], deps: FleetAppsWatchDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFinite supervision delegates launch and refusal decisions to apps-ensure. The recovery cap is checked between cycles and cannot preempt an in-flight group.`);
    return 0;
  }
  const invalid = (): number => { console.error(`error: invalid fleet apps-watch arguments\n${usage}`); return 2; };
  const apps: string[] = [];
  let duration = 0, interval = 1000, root: string | undefined, stopFile: string | undefined;
  let maxRecoveries: number | undefined;
  let maxConsecutiveFailures = 1, json = false, jsonl = false, bus = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (!(FLEET_APPS as readonly string[]).includes(arg)) return invalid();
      if (!apps.includes(arg)) apps.push(arg);
      continue;
    }
    if (!['--duration-ms', '--interval-ms', '--root', '--stop-file', '--max-consecutive-failures', '--max-recoveries', '--json', '--jsonl', '--bus'].includes(arg) || seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--bus') { bus = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--jsonl') { jsonl = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') { root = value; continue; }
    if (arg === '--stop-file') { stopFile = resolve(value); continue; }
    if (arg === '--max-recoveries') {
      if (!/^[0-9]{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 1000) return invalid();
      maxRecoveries = Number(value);
      continue;
    }
    if (arg === '--max-consecutive-failures') {
      if (!/^[1-9]$|^[1]0$/.test(value)) return invalid();
      maxConsecutiveFailures = Number(value);
      continue;
    }
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
  let fileStopped = false, fileError = false;
  const bounded = async <T>(ms: number, operation: (s: AbortSignal) => Promise<T>): Promise<{ stopped: boolean; value?: T }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let stop!: () => void;
    const stopped = new Promise<{ stopped: boolean }>(resolve => { stop = () => { controller.abort(); resolve({ stopped: true }); }; });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted || remaining() <= 0) return { stopped: true };
      timer = setTimeout(stop, ms);
      const checkFile = async (): Promise<boolean> => {
        if (!stopFile) return false;
        try {
          await stat(stopFile);
          if (!finished) { fileStopped = true; stop(); }
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            if (!finished) { fileError = true; stop(); }
            return true;
          }
          return false;
        }
      };
      const start = async (): Promise<{ stopped: boolean; value?: T }> => {
        if (await checkFile() || finished || controller.signal.aborted || signal?.aborted || remaining() <= 0) return { stopped: true };
        const watch = async (): Promise<void> => {
          if (finished || await checkFile() || finished) return;
          poll = setTimeout(() => { void watch(); }, 100);
        };
        if (stopFile) poll = setTimeout(() => { void watch(); }, 100);
        try { return { stopped: false, value: await operation(controller.signal) }; }
        catch { return { stopped: false }; }
      };
      return await Promise.race([start(), stopped]);
    } finally { finished = true; clearTimeout(timer); clearTimeout(poll); signal?.removeEventListener('abort', stop); }
  };
  let published = 0, publicationFailures = 0;
  let publisher: ((event: AppsWatchEvent) => boolean) | undefined;
  if (bus) {
    try { publisher = (deps.createBusPublisher ?? createAppsWatchPublisher)(root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')); }
    catch { publisher = () => false; }
  }
  const publish = (event: AppsWatchEvent): void => {
    if (!publisher) return;
    try { if (publisher(event)) published++; else publicationFailures++; } catch { publicationFailures++; }
  };
  let cycles = 0, recoveries = 0;
  let consecutiveFailures = 0, totalFailedCycles = 0;
  let lastObservedState: { app: string; observedRunning: boolean | null }[] | null = null;
  let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
  let recoveryLimitReached = false;
  while (!signal?.aborted && remaining() > 0) {
    const budget = Math.ceil(remaining());
    const result = await bounded(budget, s => {
      lastObservedState = null;
      return runChild!(['fleet', 'apps-ensure', ...apps, '--json', ...(root === undefined ? [] : ['--root', root]), '--timeout-ms', String(budget)], { timeoutMs: budget, signal: s });
    });
    if (signal?.aborted) break;
    if (result.stopped || !result.value || remaining() <= 0) { outcome = 'failed'; break; }
    cycles++;
    let report: { ok?: unknown; apps?: unknown } | null = null;
    try { report = JSON.parse(result.value.stdout) as { ok?: unknown; apps?: unknown } | null; } catch { /* Untrusted child output. */ }
    const rows = report && Array.isArray(report.apps) ? report.apps as Record<string, unknown>[] : [];
    const valid = rows.length === apps.length && rows.every(row => row && typeof row === 'object' && typeof row.app === 'string' && apps.includes(row.app)) && new Set(rows.map(row => row.app)).size === apps.length;
    if (valid) lastObservedState = apps.map(app => {
      const observed = rows.find(row => row.app === app)!.observedRunning;
      return { app, observedRunning: typeof observed === 'boolean' ? observed : null };
    });
    const healthy = result.value.code === 0 && report?.ok === true && valid && rows.every(row => row.observedRunning === true);
    const recovered = rows.filter(row => row && typeof row === 'object' && typeof row.app === 'string'
      && apps.includes(row.app) && typeof row.observedRunning === 'boolean' && row.launched === true
      && rows.filter(other => other && typeof other === 'object' && other.app === row.app).length === 1).length;
    recoveries += recovered;
    if (!healthy) {
      consecutiveFailures++;
      totalFailedCycles++;
      publish({ kind: 'apps-watch.observation.v1', cycle: cycles, healthy, recoveries: recovered, consecutiveFailures, totalFailedCycles, observedState: valid ? lastObservedState : null });
      if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'observation', cycle: cycles, healthy, recoveries: recovered, consecutiveFailures, totalFailedCycles, observedState: valid ? lastObservedState : null })}\n`);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        outcome = 'failed';
      }
      if (maxRecoveries !== undefined && recoveries >= maxRecoveries) { recoveryLimitReached = true; outcome = 'failed'; break; }
      const left = remaining();
      if (outcome === 'failed' || left <= 0) break;
      const pause = await bounded(left, s => sleep(Math.min(interval, left), s));
      if (pause.stopped) break;
      continue;
    }
    consecutiveFailures = 0;
    publish({ kind: 'apps-watch.observation.v1', cycle: cycles, healthy, recoveries: recovered, consecutiveFailures, totalFailedCycles, observedState: valid ? lastObservedState : null });
    if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'observation', cycle: cycles, healthy, recoveries: recovered, consecutiveFailures, totalFailedCycles, observedState: valid ? lastObservedState : null })}\n`);
    if (maxRecoveries !== undefined && recoveries >= maxRecoveries) { recoveryLimitReached = true; outcome = 'failed'; break; }
    const left = remaining();
    if (left <= 0) break;
    const pause = await bounded(left, s => sleep(Math.min(interval, left), s));
    if (pause.stopped || remaining() <= 0) break;
  }
  if (fileError) outcome = 'failed';
  else if (signal?.aborted || fileStopped) outcome = 'cancelled';
  const details = { apps, outcome, cycles, recoveries, consecutiveFailures, totalFailedCycles, lastObservedState };
  publish({ kind: 'apps-watch.summary.v1', ...details });
  const summary = { ...details, ...(recoveryLimitReached && outcome === 'failed' && !fileError ? { reason: 'recovery_limit' } : {}), ...(bus ? { bus: { published, failed: publicationFailures } } : {}) };
  if (jsonl) process.stdout.write(`${JSON.stringify({ type: 'summary', ...summary })}\n`);
  else if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else console.log(`${apps.join(', ')}: ${outcome}; cycles=${cycles}, recoveries=${recoveries}${recoveryLimitReached && outcome === 'failed' && !fileError ? '; recovery limit reached' : ''}${bus ? `; bus published=${published}, failed=${publicationFailures}` : ''}`);
  return outcome === 'completed' ? 0 : 1;
}
