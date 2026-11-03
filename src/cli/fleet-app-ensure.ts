/** Idempotent "make sure this app is running": status, launch once only if definitively stopped, then observe. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { awaitAppState } from '../core/fleet/app-await.js';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from './fleet-app.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet app-ensure <app> [--root <dir>] [--timeout-ms <n>] [--interval-ms <n>] [--json]';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVAL_MS = 1_000;

export interface FleetAppEnsureDeps {
  exec?: FleetAppExec;
  locateScript?: (root: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

type Outcome = 'running' | 'launched' | 'unavailable' | 'launch-failed' | 'timeout' | 'cancelled';

const runChild: FleetAppExec = async (file, argv, options) => {
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
  let attempts = 0;
  let running: boolean | null = null;
  let launched = false;

  /** One app_control.py action bounded by the remaining budget; a valid ok:true report or null (stdout from a failing exit never counts). */
  const control = async (action: 'status' | 'launch', budgetMs: number): Promise<Record<string, unknown> | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // Wall timer and abort listener so a never-settling exec cannot outlive the deadline.
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), Math.max(0, budgetMs));
        onAbort = () => reject(new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const { stdout } = await Promise.race([exec('python3', ['-I', script, action, app, '--output-dir', selectedRoot], {
        encoding: 'utf8', timeout: budgetMs, maxBuffer: 1024 * 1024, windowsHide: true,
      }), bound]);
      const parsed: unknown = JSON.parse(stdout);
      return parsed !== null && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === true
        ? parsed as Record<string, unknown> : null;
    } catch { return null; } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
  const status = async (budgetMs: number): Promise<boolean | null> => {
    const r = await control('status', budgetMs);
    return r !== null && typeof r.running === 'boolean' ? r.running : null;
  };

  const decide = async (): Promise<Outcome> => {
    if (signal?.aborted) return 'cancelled';
    if (deadline - now() <= 0) return 'unavailable';
    attempts++;
    const first = await status(deadline - now());
    if (signal?.aborted) return 'cancelled';
    if (first === null) return deadline - now() <= 0 ? 'timeout' : 'unavailable';
    running = first;
    if (first) return 'running';
    const left = deadline - now();
    if (left <= 0) return 'timeout';
    launched = true; // one attempt only; never retried even if its report is unusable
    const report = await control('launch', left);
    if (signal?.aborted) return 'cancelled';
    if (report === null) return deadline - now() <= 0 ? 'timeout' : 'launch-failed';
    const awaited = await awaitAppState({
      target: 'running', timeoutMs: Math.max(0, deadline - now()), intervalMs, now: deps.now, sleep: deps.sleep, signal,
      probe: status,
    });
    attempts += awaited.attempts;
    running = awaited.running ?? running;
    if (awaited.outcome === 'reached') return 'launched';
    return awaited.outcome === 'cancelled' ? 'cancelled' : 'timeout';
  };

  const outcome = await decide();
  const ok = outcome === 'running' || outcome === 'launched';
  if (json) process.stdout.write(`${JSON.stringify({ app, outcome, launched, attempts, running })}\n`);
  else if (ok) console.log(`${app}: ${MESSAGES[outcome]}`);
  else console.error(`${app}: ${MESSAGES[outcome]}`);
  return ok ? 0 : 1;
}
