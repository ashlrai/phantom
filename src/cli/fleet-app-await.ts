/** Wait (finite deadline) until a managed Mac app is running or stopped; observes only via `status`. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { awaitAppState, type AppAwaitResult, type AppAwaitTarget } from '../core/fleet/app-await.js';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from './fleet-app.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet app-await <app> --state <running|stopped> [--root <dir>] [--timeout-ms <n>] [--interval-ms <n>] [--json]';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_INTERVAL_MS = 1_000;

export interface FleetAppAwaitDeps {
  exec?: FleetAppExec;
  locateScript?: (root: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const runStatus: FleetAppExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

function positiveInt(text: string | undefined): number | null {
  return text !== undefined && /^[0-9]{1,9}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

const MESSAGES: Record<AppAwaitResult['outcome'], (app: string, target: string) => string> = {
  reached: (app, target) => `${app}: ${target}`,
  timeout: (app, target) => `${app}: timed out waiting for ${target}`,
  cancelled: (app, target) => `${app}: cancelled while waiting for ${target}`,
  unavailable: (app, target) => `${app}: status unavailable while waiting for ${target}`,
};

export async function cmdFleetAppAwait(args: string[], deps: FleetAppAwaitDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPolls the existing app_control.py status (one probe at a time) until the app is running or stopped, or the deadline passes. Never launches, focuses, quits or restarts. Timeout default 30000 ms (max 300000), interval default 1000 ms. Exit 0 reached, 1 timed out, cancelled or unavailable, 2 invalid arguments.`);
    return 0;
  }
  const invalid = (why?: string): number => {
    console.error(`error: invalid fleet app-await arguments${why ? `: ${why}` : ''}\n${usage}`);
    return 2;
  };
  const [app, ...flags] = args;
  if (!app || !(FLEET_APPS as readonly string[]).includes(app)) return invalid('unknown app');
  let state: AppAwaitTarget | undefined;
  let root: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (!['--state', '--root', '--timeout-ms', '--interval-ms', '--json'].includes(flag)) return invalid(`unknown option`);
    if (seen.has(flag)) return invalid(`duplicate ${flag}`);
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    const value = flags[++i];
    if (value === undefined || value === '' || value.startsWith('-')) return invalid(`${flag} needs a value`);
    if (flag === '--state') {
      if (value !== 'running' && value !== 'stopped') return invalid('--state must be running or stopped');
      state = value;
    } else if (flag === '--root') root = value;
    else {
      const n = positiveInt(value);
      if (n === null) return invalid(`${flag} must be a positive integer`);
      if (flag === '--timeout-ms') timeoutMs = Math.min(n, MAX_TIMEOUT_MS);
      else intervalMs = n;
    }
  }
  if (!state) return invalid('--state is required');
  const selectedRoot = root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const script = deps.locateScript ? deps.locateScript(selectedRoot) : (findAppControlScript() ?? findInstalledAppControlScript(selectedRoot));
  if (script === null) {
    console.error('fleet app-await: app control script not found; use a Phantom source checkout or run ashlr fleet bridge-install --apply');
    return 1;
  }
  const exec = deps.exec ?? runStatus;
  const target = state;
  const result = await awaitAppState({
    target, timeoutMs, intervalMs, now: deps.now, sleep: deps.sleep, signal: deps.signal,
    probe: async budgetMs => {
      let stdout: string;
      try {
        ({ stdout } = await exec('python3', ['-I', script, 'status', app, '--output-dir', selectedRoot], {
          encoding: 'utf8', timeout: budgetMs, maxBuffer: 1024 * 1024, windowsHide: true,
        }));
      } catch { return null; }
      try {
        const parsed: unknown = JSON.parse(stdout);
        const r = parsed as { ok?: unknown; running?: unknown } | null;
        return r !== null && typeof r === 'object' && r.ok === true && typeof r.running === 'boolean' ? r.running : null;
      } catch { return null; }
    },
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ app, target, outcome: result.outcome, attempts: result.attempts, running: result.running, elapsedMs: result.elapsedMs })}\n`);
  } else if (result.outcome === 'reached') console.log(MESSAGES.reached(app, target));
  else console.error(MESSAGES[result.outcome](app, target));
  return result.outcome === 'reached' ? 0 : 1;
}
