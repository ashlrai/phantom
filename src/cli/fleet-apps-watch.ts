/** Finite supervision of an explicit app group through sequential apps-ensure batches. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { selfCliPrefix, type AppsEnsureChildRunner } from './fleet-apps-ensure.js';

const execFileAsync = promisify(execFile);

/** Structured result returned by the supervision loop (no stdout rendering). */
export interface FleetAppsWatchResult {
  apps: string[];
  outcome: 'completed' | 'failed' | 'cancelled';
  cycles: number;
  recoveries: number;
  consecutiveFailures: number;
  totalFailedCycles: number;
  lastObservedState: { app: string; observedRunning: boolean | null }[] | null;
}

/** Per-cycle observation written by the CLI for JSONL output. */
export interface FleetAppsWatchObservation {
  type: 'observation';
  cycle: number;
  healthy: boolean;
  recoveries: number;
  consecutiveFailures: number;
  totalFailedCycles: number;
  observedState: { app: string; observedRunning: boolean | null }[] | null;
}

/** Options accepted by the structured watch helper. */
export interface FleetAppsWatchOptions {
  apps: string[];
  durationMs: number;
  intervalMs?: number;
  root?: string;
  stopFile?: string;
  maxConsecutiveFailures?: number;
}

/** Dependencies injected for testing (child runner, clock, sleep, signal, observation callback). */
export interface FleetAppsWatchDeps {
  runChild?: AppsEnsureChildRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Called for each observation; CLI can render JSONL from it. */
  onObservation?: (obs: FleetAppsWatchObservation) => void;
}

export async function cmdFleetAppsWatch(args: string[], deps: FleetAppsWatchDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(
      `Usage: ashlr fleet apps-watch <app>... --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--max-consecutive-failures <1..10>] [--json | --jsonl]\nFinite supervision delegates launch and refusal decisions to apps-ensure.`,
    );
    return 0;
  }
  const invalid = (): number => {
    console.error(
      `error: invalid fleet apps-watch arguments\nUsage: ashlr fleet apps-watch <app>... --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--max-consecutive-failures <1..10>] [--json | --jsonl]`,
    );
    return 2;
  };
  const apps: string[] = [];
  let duration = 0, interval = 1000, root: string | undefined, stopFile: string | undefined;
  let maxConsecutiveFailures = 1, json = false, jsonl = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (!(FLEET_APPS as readonly string[]).includes(arg)) return invalid();
      if (!apps.includes(arg)) apps.push(arg);
      continue;
    }
    if (
      !['--duration-ms', '--interval-ms', '--root', '--stop-file', '--max-consecutive-failures', '--json', '--jsonl'].includes(
        arg,
      ) ||
      seen.has(arg)
    )
      return invalid();
    seen.add(arg);
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--jsonl') {
      jsonl = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') {
      root = value;
      continue;
    }
    if (arg === '--stop-file') {
      stopFile = resolve(value);
      continue;
    }
    if (arg === '--max-consecutive-failures') {
      if (!/^[1-9]$|^[1]0$/.test(value)) return invalid();
      maxConsecutiveFailures = Number(value);
      continue;
    }
    if (!/^[0-9]{1,9}$/.test(value)) return invalid();
    const n = Number(value);
    if (arg === '--duration-ms') {
      if (n < 1 || n > 300000) return invalid();
      duration = n;
    } else {
      if (n < 100 || n > 60000) return invalid();
      interval = n;
    }
  }
  if (!apps.length || !duration || (json && jsonl)) return invalid();

  // Ensure a default child runner (CLI mode only).
  if (!deps.runChild && !deps.signal?.aborted) {
    const prefix = selfCliPrefix();
    if (prefix === null) {
      console.error('fleet apps-watch: cannot resolve the ashlr CLI entry');
      return 1;
    }
    deps.runChild = async (argv, options) => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [...prefix, ...argv], {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          signal: options.signal,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return { code: 0, stdout };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: unknown };
        return { code: typeof e.code === 'number' ? e.code : null, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
      }
    };
  }

  const observations: FleetAppsWatchObservation[] = [];
  const result = await watchFleetApps(
    { apps, durationMs: duration, intervalMs: interval, root, stopFile, maxConsecutiveFailures },
    { ...deps, onObservation: (obs) => { observations.push(obs); } },
  );

  // CLI: render as stdout.
  if (jsonl) {
    for (const obs of observations) {
      process.stdout.write(`${JSON.stringify(obs)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ type: 'summary', ...result })}\n`);
  } else if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    console.log(`${result.apps.join(', ')}: ${result.outcome}; cycles=${result.cycles}, recoveries=${result.recoveries}`);
  }
  return result.outcome === 'completed' ? 0 : 1;
}

/**
 * Structured supervision loop — no stdout rendering.
 * The CLI and MCP both call this; each is responsible for its own output form.
 */
export async function watchFleetApps(
  options: FleetAppsWatchOptions,
  deps: FleetAppsWatchDeps = {},
): Promise<FleetAppsWatchResult> {
  const { apps, durationMs, intervalMs, root, stopFile, maxConsecutiveFailures: maxCF = 1 } = options;
  let runChild = deps.runChild;

  // Default child runner when no child runner is injected (MCP callers always inject one).
  if (!runChild && !deps.signal?.aborted) {
    const prefix = selfCliPrefix();
    if (prefix === null) {
      throw new Error('fleet apps-watch: cannot resolve the ashlr CLI entry');
    }
    runChild = async (argv, options) => {
      try {
        const { stdout } = await execFileAsync(process.execPath, [...prefix, ...argv], {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          signal: options.signal,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return { code: 0, stdout };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: unknown };
        return { code: typeof e.code === 'number' ? e.code : null, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
      }
    };
  }

  const now = deps.now ?? (() => performance.now());
  const start = now();
  const wallStart = performance.now();
  const remaining = (): number =>
    Math.max(0, durationMs - Math.max(0, now() - start, performance.now() - wallStart));
  const signal = deps.signal;
  const sleep =
    deps.sleep ??
    ((ms: number, s: AbortSignal) =>
      new Promise<void>(resolve => {
        const done = (): void => {
          clearTimeout(timer);
          s.removeEventListener('abort', done);
          resolve();
        };
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
    const stopped = new Promise<{ stopped: boolean }>(resolve => {
      stop = () => {
        controller.abort();
        resolve({ stopped: true });
      };
    });
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted || remaining() <= 0) return { stopped: true };
      timer = setTimeout(stop, ms);
      const checkFile = async (): Promise<boolean> => {
        if (!stopFile) return false;
        try {
          await stat(stopFile);
          if (!finished) {
            fileStopped = true;
            stop();
          }
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            if (!finished) {
              fileError = true;
              stop();
            }
            return true;
          }
          return false;
        }
      };
      const start = async (): Promise<{ stopped: boolean; value?: T }> => {
        if (await checkFile() || finished || controller.signal.aborted || signal?.aborted || remaining() <= 0)
          return { stopped: true };
        const watch = async (): Promise<void> => {
          if (finished || (await checkFile()) || finished) return;
          poll = setTimeout(() => {
            void watch();
          }, 100);
        };
        if (stopFile) poll = setTimeout(() => void watch(), 100);
        try {
          return { stopped: false, value: await operation(controller.signal) };
        } catch {
          return { stopped: false };
        }
      };
      return await Promise.race([start(), stopped]);
    } finally {
      finished = true;
      clearTimeout(timer);
      clearTimeout(poll);
      signal?.removeEventListener('abort', stop);
    }
  };

  let cycles = 0, recoveries = 0;
  let consecutiveFailures = 0, totalFailedCycles = 0;
  let lastObservedState: { app: string; observedRunning: boolean | null }[] | null = null;
  let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';

  while (!signal?.aborted && remaining() > 0) {
    const budget = Math.ceil(remaining());
    const result = await bounded(budget, s => {
      
      return runChild!(
        [
          'fleet',
          'apps-ensure',
          ...apps,
          '--json',
          ...(root === undefined ? [] : ['--root', root]),
          '--timeout-ms',
          String(budget),
        ],
        { timeoutMs: budget, signal: s },
      );
    });
    if (signal?.aborted) break;
    if (result.stopped || !result.value || remaining() <= 0) {
      outcome = 'failed';
      break;
    }
    cycles++;
    let report: { ok?: unknown; apps?: unknown } | null = null;
    try {
      report = JSON.parse(result.value.stdout) as { ok?: unknown; apps?: unknown } | null;
    } catch {
      /* Untrusted child output. */
    }
    const rows = report && Array.isArray(report.apps) ? (report.apps as Record<string, unknown>[]) : [];
    const valid =
      rows.length === apps.length &&
      rows.every(row => row && typeof row === 'object' && typeof row.app === 'string' && apps.includes(row.app)) &&
      new Set(rows.map(row => row.app)).size === apps.length;
    if (valid)
      lastObservedState = apps.map(app => {
        const observed = (rows.find(row => row.app === app) as { observedRunning?: unknown }).observedRunning;
        return { app, observedRunning: typeof observed === 'boolean' ? observed : null };
      });
    const healthy =
      result.value.code === 0 &&
      report?.ok === true &&
      valid &&
      rows.every(row => (row as { observedRunning?: boolean }).observedRunning === true);
    const recovered = healthy
      ? rows.filter(row => (row as { launched?: boolean }).launched === true).length
      : 0;
    recoveries += recovered;
    if (!healthy) {
      totalFailedCycles++;
      consecutiveFailures++;
      if (consecutiveFailures >= maxCF) {
        outcome = 'failed';
      }
    } else {
      consecutiveFailures = 0;
    }
    const obs: FleetAppsWatchObservation = {
      type: 'observation',
      cycle: cycles,
      healthy,
      recoveries: recovered,
      consecutiveFailures,
      totalFailedCycles,
      observedState: valid ? lastObservedState : null,
    };
    deps.onObservation?.(obs);
    if (!healthy) {
      const left = remaining();
      if (outcome === 'failed' || left <= 0) break;
      const pause = await bounded(left, s => sleep(Math.min(intervalMs, left), s));
      if (pause.stopped) break;
      continue;
    }
    const left = remaining();
    if (left <= 0) break;
    const pause = await bounded(left, s => sleep(Math.min(intervalMs, left), s));
    if (pause.stopped || remaining() <= 0) break;
  }
  if (fileError) outcome = 'failed';
  else if (signal?.aborted || fileStopped) outcome = 'cancelled';
  return { apps, outcome, cycles, recoveries, consecutiveFailures, totalFailedCycles, lastObservedState };
}
