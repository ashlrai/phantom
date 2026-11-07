/** Idempotent "make sure this app is running": status, launch once only if definitively stopped, then observe. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { awaitAppState } from '../core/fleet/app-await.js';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExecOptions } from './fleet-app.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet app-ensure <app> [--root <dir>] [--timeout-ms <n>] [--interval-ms <n>] [--json]';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVAL_MS = 1_000;

/** A FleetAppExec whose options also carry the child's AbortSignal, so a stopped run can reclaim its child. */
export type FleetAppEnsureExec =
  (file: string, argv: readonly string[], options: FleetAppExecOptions & { signal: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

export interface FleetAppEnsureDeps {
  exec?: FleetAppEnsureExec;
  locateScript?: (root: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

type Outcome = 'running' | 'launched' | 'unavailable' | 'launch-failed' | 'timeout' | 'cancelled';
type Stop = 'cancelled' | 'timeout';

const runChild: FleetAppEnsureExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

function positiveInt(text: string | undefined): number | null {
  return text !== undefined && /^[0-9]{1,9}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

const MESSAGES: Record<Outcome, string> = {
  running: 'already running',
  launched: 'launched and running',
  unavailable: 'status unavailable; not launched',
  'launch-failed': 'launch was not accepted',
  timeout: 'timed out before running was observed',
  cancelled: 'cancelled',
};

export async function cmdFleetAppEnsure(args: string[], deps: FleetAppEnsureDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nProbes app_control.py status; if the app is running it does nothing more. Only when status definitively reports stopped does it launch once, then polls status until running is observed. Never focuses, quits, restarts or kills. One total deadline covers every step: default 30000 ms (max 300000), interval default 1000 ms. Exit 0 observed running, 1 any other outcome, 2 invalid arguments.`);
    return 0;
  }
  const invalid = (why: string): number => {
    console.error(`error: invalid fleet app-ensure arguments: ${why}\n${usage}`);
    return 2;
  };
  const [app, ...flags] = args;
  if (!app || !(FLEET_APPS as readonly string[]).includes(app)) return invalid('unknown app');
  let root: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (!['--root', '--timeout-ms', '--interval-ms', '--json'].includes(flag)) return invalid('unknown option');
    if (seen.has(flag)) return invalid(`duplicate ${flag}`);
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const value = flags[++i];
    if (value === undefined || value === '' || value.startsWith('-')) return invalid(`${flag} needs a value`);
    if (flag === '--root') root = value;
    else {
      const n = positiveInt(value);
      if (n === null) return invalid(`${flag} must be a positive integer`);
      if (flag === '--timeout-ms') timeoutMs = Math.min(n, MAX_TIMEOUT_MS);
      else intervalMs = n;
    }
  }
  const selectedRoot = root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const script = deps.locateScript ? deps.locateScript(selectedRoot) : (findAppControlScript() ?? findInstalledAppControlScript(selectedRoot));
  if (script === null) {
    console.error('fleet app-ensure: app control script not found; use a Phantom source checkout or run ashlr fleet bridge-install --apply');
    return 1;
  }
  const exec = deps.exec ?? runChild;
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const deadline = now() + timeoutMs;

  // Every child of this run listens to `scope`, so a supervisor cancel, the deadline or the end of the run aborts the live child.
  const scope = new AbortController();
  let stopped: Stop | null = null;
  const stop = (reason: Stop): void => {
    stopped ??= reason;
    scope.abort();
  };
  const onCancel = (): void => stop('cancelled');
  signal?.addEventListener('abort', onCancel, { once: true });
  // Registration race: an abort that landed before the listener existed, or an already-aborted signal, never fires it.
  if (signal?.aborted) stop('cancelled');
  const deadlineTimer = setTimeout(() => stop('timeout'), timeoutMs);
  // The confirmation wait wakes on abort too, so a stopped run leaves no sleep timer behind.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => {
    const wake = (): void => {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    scope.signal.addEventListener('abort', wake, { once: true });
  }));

  let attempts = 0;
  let running: boolean | null = null;
  let launched = false;

  /** One app_control.py action, bounded by the remaining budget and aborted with the run: a valid ok:true report or null (stdout from a failing exit never counts). */
  const control = async (action: 'status' | 'launch', budgetMs: number): Promise<Record<string, unknown> | null> => {
    // Never spawn after a stop; a zero timeout would mean "no limit" to execFile.
    if (scope.signal.aborted || budgetMs <= 0) return null;
    const child = new AbortController();
    let onStop: (() => void) | undefined;
    try {
      // The run's stop (cancel or the one deadline timer) rejects this wait, so a child that ignores its signal still cannot outlive the run.
      const stopping = new Promise<never>((_, reject) => {
        onStop = () => {
          reject(new Error('stopped'));
          child.abort();
        };
        scope.signal.addEventListener('abort', onStop, { once: true });
      });
      // Registration race: a stop that landed before the listener above would never fire it.
      if (scope.signal.aborted) return null;
      const work = (async () => exec('python3', ['-I', script, action, app, '--output-dir', selectedRoot], {
        encoding: 'utf8', timeout: budgetMs, maxBuffer: 1024 * 1024, windowsHide: true, signal: child.signal,
      }))();
      // A child that rejects after the run stopped is consumed here; the outcome was already decided.
      work.catch(() => {});
      const { stdout } = await Promise.race([work, stopping]);
      const parsed: unknown = JSON.parse(stdout);
      return parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true
        ? parsed as Record<string, unknown> : null;
    } catch { return null; } finally {
      if (onStop) scope.signal.removeEventListener('abort', onStop);
    }
  };
  const status = async (budgetMs: number): Promise<boolean | null> => {
    const r = await control('status', budgetMs);
    return r !== null && typeof r.running === 'boolean' ? r.running : null;
  };

  const decide = async (): Promise<Outcome> => {
    if (stopped) return stopped;
    if (deadline - now() <= 0) return 'unavailable';
    attempts++;
    const first = await status(deadline - now());
    if (stopped) return stopped;
    if (first === null) return deadline - now() <= 0 ? 'timeout' : 'unavailable';
    running = first;
    if (first) return 'running';
    const left = deadline - now();
    if (left <= 0) return 'timeout';
    launched = true; // one attempt only; never retried even if its report is unusable
    const report = await control('launch', left);
    if (stopped) return stopped;
    if (report === null) return deadline - now() <= 0 ? 'timeout' : 'launch-failed';
    const awaited = await awaitAppState({
      target: 'running', timeoutMs: Math.max(0, deadline - now()), intervalMs, now: deps.now, sleep, signal: scope.signal,
      probe: status,
    });
    attempts += awaited.attempts;
    running = awaited.running ?? running;
    if (awaited.outcome === 'reached') return 'launched';
    return stopped ?? 'timeout';
  };

  let outcome: Outcome;
  try {
    outcome = await decide();
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', onCancel);
    scope.abort(); // reclaims any child still running, whichever path ended the run
  }
  const ok = outcome === 'running' || outcome === 'launched';
  if (json) process.stdout.write(`${JSON.stringify({ app, outcome, launched, attempts, running })}\n`);
  else if (ok) console.log(`${app}: ${MESSAGES[outcome]}`);
  else console.error(`${app}: ${MESSAGES[outcome]}`);
  return ok ? 0 : 1;
}
