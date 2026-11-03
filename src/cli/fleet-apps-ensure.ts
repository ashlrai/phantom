/** Sequential recovery over an explicit allowlisted app list: one app-ensure child per app, one shared budget, one aggregate JSON report. */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';

const execFileAsync = promisify(execFile);
const usage = 'Usage: ashlr fleet apps-ensure <app>... [--root <dir>] [--timeout-ms <n>] [--interval-ms <n>] [--json]';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const FLAGS = new Set(['--root', '--timeout-ms', '--interval-ms', '--json']);
// app-ensure outcomes that mean observed running; any other outcome is a batch failure.
const RUNNING_OUTCOMES = new Set(['running', 'launched']);

/** Raw child result: exit code (null if it never exited normally) and stdout, which is parsed but never printed. */
export interface AppsEnsureChildRun { code: number | null; stdout: string }
/** Injected in tests so no real process or Mac app is touched. */
export type AppsEnsureChildRunner =
  (args: readonly string[], options: { timeoutMs: number; signal: AbortSignal }) => Promise<AppsEnsureChildRun>;
export interface FleetAppsEnsureDeps { runChild?: AppsEnsureChildRunner; now?: () => number; signal?: AbortSignal }

interface AppResult { app: string; attempted: boolean; outcome: string; launched: boolean; observedRunning: boolean; reason?: 'deadline' | 'cancelled' }
interface ParsedArgs { apps: string[]; root?: string; timeoutMs: number; intervalMs?: number; json: boolean }

/** Every argument is validated before any child runs; returns the rejection reason, or the parsed batch. */
function parseArgs(args: string[]): ParsedArgs | string {
  const out: ParsedArgs = { apps: [], timeoutMs: DEFAULT_TIMEOUT_MS, json: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (!(FLEET_APPS as readonly string[]).includes(arg)) return 'unknown app';
      if (!out.apps.includes(arg)) out.apps.push(arg);
      continue;
    }
    if (!FLAGS.has(arg)) return 'unknown option';
    if (seen.has(arg)) return `duplicate ${arg}`;
    seen.add(arg);
    if (arg === '--json') { out.json = true; continue; }
    const value = args[++i];
    if (value === undefined || value === '' || value.startsWith('-')) return `${arg} needs a value`;
    if (arg === '--root') { out.root = value; continue; }
    const n = /^[0-9]{1,9}$/.test(value) && Number(value) > 0 ? Number(value) : null;
    if (n === null) return `${arg} must be a positive integer`;
    if (arg === '--interval-ms') out.intervalMs = n;
    else if (n > MAX_TIMEOUT_MS) return `--timeout-ms maximum is ${MAX_TIMEOUT_MS}`;
    else out.timeoutMs = n;
  }
  return out.apps.length === 0 ? 'name at least one app; there is no implicit all-apps' : out;
}

/** The app-ensure report naming this app, or null unless stdout is exactly one JSON object for it. */
function parseReport(stdout: string, app: string): { outcome: string; running: boolean; launched: boolean } | null {
  try {
    const v = JSON.parse(stdout) as Record<string, unknown> | null;
    if (v === null || typeof v !== 'object' || v.app !== app || typeof v.outcome !== 'string') return null;
    return { outcome: v.outcome, running: v.running === true, launched: v.launched === true };
  } catch {
    return null;
  }
}

/** Real child: execFile with no shell and a fixed argv. app-ensure exits 1 with its JSON on stdout for non-running outcomes, so that stdout is kept. */
const execCli = (prefix: readonly string[]): AppsEnsureChildRunner => async (args, { timeoutMs, signal }) => {
  try {
    const { stdout } = await execFileAsync(process.execPath, [...prefix, ...args], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, signal,
    });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown };
    return { code: typeof e.code === 'number' ? e.code : null, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
  }
};

/**
 * The argv prefix that re-runs this CLI, resolved as local-runtime.ts does: execArgv (loaders from a source run)
 * plus the absolute entry script. No argv[1] means a packaged binary, where execPath is the CLI. Null when untrusted.
 */
export function selfCliPrefix(argv: readonly string[] = process.argv, execArgv: readonly string[] = process.execArgv): string[] | null {
  const entry = argv[1];
  if (entry === undefined) return [];
  if (!isAbsolute(entry)) return null;
  try {
    return statSync(entry).isFile() ? [...execArgv, entry] : null;
  } catch {
    return null;
  }
}

export async function cmdFleetAppsEnsure(args: string[], deps: FleetAppsEnsureDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRuns app-ensure once per listed app, in order, under one total deadline (default 30000 ms, max 300000). Each app gets the remaining budget; no app starts after the deadline or an abort, and skipped apps are listed as not attempted. An ordinary app failure does not stop the batch. Exit 0 only when every app was observed running; 1 otherwise; 2 invalid arguments.`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') { console.error(`error: invalid fleet apps-ensure arguments: ${parsed}\n${usage}`); return 2; }
  let runChild = deps.runChild;
  if (runChild === undefined) {
    const prefix = selfCliPrefix();
    if (prefix === null) { console.error('fleet apps-ensure: cannot resolve the ashlr CLI entry; run it from the ashlr bin'); return 1; }
    runChild = execCli(prefix);
  }
  const { apps, root, timeoutMs, intervalMs, json } = parsed;
  const now = deps.now ?? Date.now;
  const signal = deps.signal;
  const deadline = now() + timeoutMs;
  const forwarded = [...(root === undefined ? [] : ['--root', root]), ...(intervalMs === undefined ? [] : ['--interval-ms', String(intervalMs)])];

  /** One app-ensure child; the remaining budget bounds both its own timeout and a hard wall timer. */
  const attempt = async (app: string, budgetMs: number): Promise<AppResult> => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A child that ignores its own timeout still cannot outlive the batch budget.
    const bound = new Promise<AppsEnsureChildRun>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ code: null, stdout: '' });
      }, budgetMs);
    });
    const child = runChild(['fleet', 'app-ensure', app, '--timeout-ms', String(budgetMs), ...forwarded, '--json'], {
      timeoutMs: budgetMs, signal: controller.signal,
    }).catch((): AppsEnsureChildRun => ({ code: null, stdout: '' }));
    try {
      const { code, stdout } = await Promise.race([child, bound]);
      const reported = parseReport(stdout, app);
      const outcome = reported?.outcome ?? (signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'unavailable');
      const observedRunning = code === 0 && reported !== null && reported.running && RUNNING_OUTCOMES.has(reported.outcome);
      return { app, attempted: true, outcome, launched: reported?.launched === true, observedRunning };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  // Sequential on purpose: one heavy child at a time, budget checked before each one.
  const results: AppResult[] = [];
  for (const app of apps) {
    if (signal?.aborted || Math.floor(deadline - now()) <= 0) break;
    results.push(await attempt(app, Math.floor(deadline - now())));
  }
  const endedBy = results.length === apps.length ? 'complete' : signal?.aborted ? 'cancelled' : 'deadline';
  const rows: AppResult[] = apps.map((app, i) => results[i]
    ?? { app, attempted: false, outcome: 'unattempted', launched: false, observedRunning: false, reason: endedBy === 'cancelled' ? 'cancelled' : 'deadline' });
  const ok = rows.every(row => row.observedRunning);

  if (json) process.stdout.write(`${JSON.stringify({ ok, endedBy, timeoutMs, apps: rows })}\n`);
  else {
    for (const row of rows) {
      const text = row.attempted ? `${row.app}: ${row.outcome}` : `${row.app}: not attempted (${row.reason})`;
      if (row.observedRunning) console.log(text);
      else console.error(text);
    }
  }
  return ok ? 0 : 1;
}
