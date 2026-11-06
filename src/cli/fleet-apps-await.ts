/** Observe an explicit GUI app set under one finite readiness budget. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { awaitAppState } from '../core/fleet/app-await.js';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from './fleet-app.js';

const execAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FleetAppsAwaitDeps {
  exec?: (file: string, argv: readonly string[], options: Parameters<FleetAppExec>[2] & { signal: AbortSignal }) => ReturnType<FleetAppExec>;
  locateScript?: () => string | null;
  locateInstalledScript?: (root: string) => string | null;
  /** Monotonic milliseconds; the real monotonic clock also bounds injected dependencies. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface FleetAppsAwaitOptions {
  /** 1..8 unique existing FLEET_APPS names. */
  apps: string[];
  /** 'running' | 'stopped' — default 'running'. */
  target?: 'running' | 'stopped';
  /** 1..30000 ms shared wall deadline. */
  timeoutMs?: number;
  /** 100..60000 ms between probe rounds. */
  intervalMs?: number;
  /** Local root for script discovery (default ~/.ashlr-runs). */
  root?: string;
}

export interface FleetAppsAwaitRow { app: string; running: boolean | null }
export interface FleetAppsAwaitReport { outcome: 'ready' | 'timeout' | 'unavailable'; target: 'running' | 'stopped'; elapsedMs: number; apps: FleetAppsAwaitRow[] }

// ---------------------------------------------------------------------------
// Structured helper (used by CLI and MCP)
// ---------------------------------------------------------------------------

const usage = 'Usage: ashlr fleet apps-await --apps <names> --timeout-ms <1-300000> [--target running|stopped] [--interval-ms <100-60000>] [--root <dir>] [--json]';

/** Execute a bounded observe-only await over an explicit app group. The CLI entry point parses args and delegates here; MCP calls it directly. */
export async function awaitFleetApps(options: FleetAppsAwaitOptions, deps: FleetAppsAwaitDeps = {}): Promise<FleetAppsAwaitReport> {
  const { apps, target = 'running', timeoutMs = 30000, intervalMs = 1000, root } = options;
  const resolvedRoot = root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const clock = deps.now ?? (() => performance.now());
  const start = clock();
  const wallStart = performance.now();
  const elapsed = (): number => Math.max(0, clock() - start, performance.now() - wallStart);
  const rows: FleetAppsAwaitRow[] = apps.map(app => ({ app, running: null }));
  let script: string | null;
  try {
    script = (deps.locateScript ?? findAppControlScript)() ?? (deps.locateInstalledScript ?? findInstalledAppControlScript)(resolvedRoot);
  } catch { return { outcome: 'unavailable', target, elapsedMs: 0, apps: rows }; }
  if (!script) return { outcome: 'unavailable', target, elapsedMs: 0, apps: rows };
  const exec: NonNullable<FleetAppsAwaitDeps['exec']> = deps.exec ?? (async (file, argv, options) => execAsync(file, argv, options));
  const resolvedTarget = target;
  let observed = false;
  const probes = new AbortController();
  const onAbort = (): void => probes.abort();
  if (deps.signal?.aborted) onAbort();
  else deps.signal?.addEventListener('abort', onAbort, { once: true });
  const active = (): boolean => !probes.signal.aborted && elapsed() < timeoutMs;
  const result = await awaitAppState({
    target: resolvedTarget,
    timeoutMs, intervalMs, now: elapsed, sleep: deps.sleep, signal: deps.signal,
    probe: async () => {
      if (!active()) return null;
      rows.forEach(row => { row.running = null; });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (active() && next < rows.length) {
          const row = rows[next++]!;
          let running: boolean | null = null;
          try {
            const { stdout } = await exec('python3', ['-I', script, 'status', row.app, '--output-dir', resolvedRoot], {
              encoding: 'utf8', timeout: Math.max(1, Math.ceil(timeoutMs - elapsed())), maxBuffer: 1024 * 1024, windowsHide: true, signal: probes.signal,
            });
            const report: unknown = JSON.parse(stdout);
            if (report !== null && typeof report === 'object' && !Array.isArray(report)) {
              const value = report as { ok?: unknown; running?: unknown };
              if (value.ok === true && typeof value.running === 'boolean') running = value.running;
            }
          } catch { /* Unknown, never interpreted as stopped. */ }
          if (!active()) return;
          row.running = running;
          if (running !== null) observed = true;
        }
      };
      await Promise.all([worker(), worker()]);
      if (!active()) return null;
      if (resolvedTarget === 'stopped')
        return rows.every(row => row.running === false) ? false : null;
      return rows.every(row => row.running === true) ? true : observed ? false : null;
    },
  });
  probes.abort();
  return {
    outcome: result.outcome === 'reached' && !deps.signal?.aborted && elapsed() < timeoutMs ? 'ready' :
      result.outcome === 'cancelled' || !observed ? 'unavailable' : 'timeout',
    target,
    elapsedMs: elapsed(),
    apps: rows,
  };
}

// ---------------------------------------------------------------------------
// CLI entry (delegates to structured helper)
// ---------------------------------------------------------------------------

export async function cmdFleetAppsAwait(args: string[], deps: FleetAppsAwaitDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nObserve status only; never launch, quit, or restart. Names: ${FLEET_APPS.join(', ')}. Default target is running. Interval defaults to 1000 ms. Exit 0 ready, 3 timeout, 1 unavailable or aborted, 2 invalid arguments.`);
    return 0;
  }
  const invalid = (): number => { console.error(`Invalid fleet apps-await arguments\n${usage}`); return 2; };
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--apps', '--timeout-ms', '--target', '--interval-ms', '--root', '--json'].includes(flag) || flags.has(flag)) return invalid();
    const value = flag === '--json' ? 'true' : args[++i];
    if (!value || value.startsWith('-')) return invalid();
    flags.set(flag, value);
  }
  const names = flags.get('--apps')?.split(',').map(name => name.trim());
  if (!names?.length || new Set(names).size !== names.length || names.some(name => !(FLEET_APPS as readonly string[]).includes(name))) return invalid();
  const target = flags.get('--target');
  if (target !== undefined && target !== 'running' && target !== 'stopped') return invalid();
  const number = (value: string | undefined, min: number, max: number): number | null =>
    value && /^\d{1,6}$/.test(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
  const timeoutMs = number(flags.get('--timeout-ms'), 1, 300_000);
  const intervalMs = number(flags.get('--interval-ms') ?? '1000', 100, 60_000);
  if (timeoutMs === null || intervalMs === null) return invalid();
  const root = flags.get('--root') ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const report = await awaitFleetApps({
    apps: names, target: (target ?? 'running') as 'running' | 'stopped',
    timeoutMs, intervalMs, root,
  }, deps);
  const emit = (outcome: 'ready' | 'timeout' | 'unavailable'): number => {
    const view = { outcome, target: report.target, elapsedMs: report.elapsedMs, apps: report.apps };
    if (flags.has('--json')) process.stdout.write(`${JSON.stringify(view)}\n`);
    else console.log(`Fleet apps: ${outcome} (target: ${report.target})\n${report.apps.map(row => `${row.app}: ${row.running === null ? 'unknown' : row.running ? 'running' : 'stopped'}`).join('\n')}`);
    return outcome === 'ready' ? 0 : outcome === 'timeout' ? 3 : 1;
  };
  return emit(report.outcome);
}
