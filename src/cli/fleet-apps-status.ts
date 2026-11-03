/** Bulk status inventory of the eight managed GUI apps on one call. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from './fleet-app.js';

const execFileAsync = promisify(execFile);

const USAGE =
  'Usage: ashlr fleet apps-status [--root <dir>] [--json]\n' +
  'Status inventory of eight managed GUI apps (Phantom, Codex, Claude, Grok Bot, ChatGPT, Cursor, Safari, Google Chrome) via scripts/mac-bridge/app_control.py. Runs from a Phantom source checkout or from the copy that `ashlr fleet bridge-install --apply` puts under <root>/mac-bridge/current. Exits 0 ok, 1 failure or missing script.';

const MAX_PROBES = 2;
const TOTAL_MS = 20_000;

export interface FleetAppsStatusView {
  v: 1;
  generatedAt: string;
  available: boolean;
  apps: Array<{ app: string; running: boolean | null; checkedAt: string }>;
  degraded?: boolean;
}

export interface FleetAppsStatusDeps {
  exec?: FleetAppExec;
  locateScript?: () => string | null;
  now?: () => number;
  runsDir?: string;
  maxConcurrent?: number;
  totalDeadline?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Minimal CLI result shape — only allowlisted fields, never raw script output. */
function formatAppsStatusResult(view: FleetAppsStatusView, json: boolean): void {
  if (json) {
    const out: FleetAppsStatusView = {
      v: view.v,
      generatedAt: view.generatedAt,
      available: view.available,
      apps: view.apps.map(app => ({
        app: app.app,
        running: app.running,
        checkedAt: app.checkedAt,
      })),
    };
    if (view.degraded !== undefined) (out as unknown as Record<string, unknown>).degraded = view.degraded;
    process.stdout.write(JSON.stringify(out, null, 2));
    return;
  }
  const state = view.available ? (view.degraded ? 'degraded' : 'available') : 'unavailable';
  console.log(`Fleet apps status [${state}] at ${view.generatedAt}`);
  for (const app of view.apps) {
    const status = app.running === true ? 'running' : app.running === false ? 'not running' : 'unknown';
    console.log(`  ${app.app}: ${status}`);
  }
}

/** Promise-based execFile, never a shell; argv is a fixed vector. */
const defaultExec: FleetAppExec = async (file, argv, options) =>
  execFileAsync(file, argv, options);

export async function cmdFleetAppsStatus(args: string[], deps: FleetAppsStatusDeps = {}): Promise<number> {
  const clock = deps.now ?? (() => Date.now());
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const exec = deps.exec ?? defaultExec;
  const maxConcurrent = typeof deps.maxConcurrent === 'number' && deps.maxConcurrent > 0 ? deps.maxConcurrent : MAX_PROBES;
  const totalDeadline = typeof deps.totalDeadline === 'number' && deps.totalDeadline > 0 ? deps.totalDeadline : TOTAL_MS;

  // Handle --help early.
  if (args.length > 0 && ['--help', '-h'].includes(args[0])) {
    console.log(USAGE);
    return 0;
  }

  // Parse flags: --root <dir> --json, reject unknown/duplicates/positionals.
  const seen = new Set<string>();
  let json = false;
  let parsedRoot = root;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--') break;
    if (token.startsWith('-') && token.length > 1) {
      if (seen.has(token)) {
        console.error(`error: duplicate option: ${token}\n${USAGE}`);
        return 2;
      }
      if (!['--json', '--root'].includes(token)) {
        console.error(`error: unknown option: ${token}\n${USAGE}`);
        return 2;
      }
      seen.add(token);
      if (token === '--json') {
        json = true;
      } else {
        const value = args[++i];
        if (value === undefined || value.startsWith('-')) {
          console.error(`error: --root needs a directory\n${USAGE}`);
          return 2;
        }
        parsedRoot = value;
      }
    } else if (token !== '') {
      // Positional arguments are not accepted — reject.
      console.error(`error: unexpected argument: ${token}\n${USAGE}`);
      return 2;
    }
  }

  const wallDeadline = performance.now() + totalDeadline;
  const deadline = clock() + totalDeadline;
  const script = deps.locateScript ? deps.locateScript() :
    findAppControlScript() ?? findInstalledAppControlScript(parsedRoot);
  const generatedAt = new Date(clock()).toISOString();

  // Missing script: clear unavailable result, nonzero exit.
  if (script === null) {
    const view: FleetAppsStatusView = {
      v: 1,
      generatedAt,
      available: false,
      apps: FLEET_APPS.map(app => ({ app, running: null, checkedAt: generatedAt })),
    };
    formatAppsStatusResult(view, json);
    return 1;
  }

  // Build rows: all apps present, defaulting to unknown.
  const apps: FleetAppsStatusView['apps'] = FLEET_APPS.map(app => ({
    app,
    running: null,
    checkedAt: generatedAt,
  }));
  // Concurrent worker: pulls tasks from a shared index, respects deadline.
  let next = 0;
  let expired = false;
  async function worker(): Promise<void> {
    while (next < apps.length) {
      const remaining = Math.min(deadline - clock(), wallDeadline - performance.now());
      if (expired || remaining <= 0) return;
      const row = apps[next++]!;
      const probeTimeout = Math.max(remaining, 1);
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>(resolve => {
          timer = setTimeout(() => { expired = true; resolve(null); }, remaining);
        });
        let result: Awaited<ReturnType<FleetAppExec>> | null;
        try {
          result = await Promise.race([exec('python3', ['-I', script!, 'status', row.app, '--output-dir', parsedRoot], {
            encoding: 'utf8', timeout: probeTimeout, maxBuffer: 1024 * 1024, windowsHide: true,
          }), timeout]);
        } finally {
          clearTimeout(timer);
        }
        if (result === null) return;
        const parsed: unknown = JSON.parse(result.stdout);
        if (record(parsed) && parsed.ok === true && typeof parsed.running === 'boolean') {
          row.running = parsed.running;
        }
        // Malformed or missing running stays null (unknown).
      } catch {
        // Unreadable status (timeout, crash, malformed JSON) stays null.
      }
      row.checkedAt = new Date(clock()).toISOString();
    }
  }

  // Launch bounded concurrent workers.
  const active: Promise<void>[] = [];
  const probeSlots = Math.min(maxConcurrent, FLEET_APPS.length);
  for (let i = 0; i < probeSlots; i++) {
    active.push(worker());
  }
  await Promise.all(active);

  // Compute explicit available/degraded indicator.
  const hasUnknown = apps.some(row => row.running === null);
  const view: FleetAppsStatusView = {
    v: 1,
    generatedAt,
    available: true,
    degraded: hasUnknown,
    apps,
  };

  formatAppsStatusResult(view, json);
  return hasUnknown ? 1 : 0;
}
