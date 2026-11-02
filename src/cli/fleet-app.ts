/** Explicit bounded control of macOS GUI apps via scripts/mac-bridge/app_control.py. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const usage = 'Usage: ashlr fleet app <status|launch|focus|quit|restart> <app> [--root <dir>] [--json]';
const ACTIONS = new Set(['status', 'launch', 'focus', 'quit', 'restart']);
const APP_NAME = /^[A-Za-z0-9 ._-]{1,64}$/;
const TIMEOUT_MS = 30_000;

export interface FleetAppExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}
export type FleetAppExec =
  (file: string, argv: readonly string[], options: FleetAppExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface FleetAppDeps {
  exec?: FleetAppExec;
  locateScript?: () => string | null;
}

/** execFile, never a shell; argv is a fixed vector so caller text never enters a command line. */
const runAppControl: FleetAppExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

/**
 * Nearest ancestor of this module carrying scripts/mac-bridge/app_control.py.
 * The npm package does not ship scripts/, so the walk stops at the first
 * ancestor containing package.json and reports absence instead of adopting a
 * script that merely shares the path somewhere above the install root.
 */
export function findAppControlScript(from: string = fileURLToPath(import.meta.url)): string | null {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'scripts', 'mac-bridge', 'app_control.py');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One short line for humans; --json callers get the script's raw output instead. */
function formatFleetAppResult(result: Record<string, unknown>, fallback: string): string {
  const name = typeof result.app === 'string' && result.app ? result.app : fallback;
  if (typeof result.running === 'boolean') return `${name}: ${result.running ? 'running' : 'not running'}`;
  const action = typeof result.action === 'string' ? result.action : 'app';
  const code = typeof result.code === 'string' ? result.code : 'unknown';
  const needs = result.needs_mason_written === true ? ' (see NEEDS-MASON.md)' : '';
  return `${name} ${action}: ${code}${needs}`;
}

export async function cmdFleetApp(args: string[], deps: FleetAppDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nExplicitly status, launch, focus, quit or restart one bounded macOS app (Cursor, Claude, Codex, ChatGPT, Phantom, Safari, Google Chrome, Grok Bot) through scripts/mac-bridge/app_control.py. App control needs a Phantom source checkout; the npm package does not ship the script. The script makes the final app decision and performs the action; this verb never runs automatic memory-path termination. Exit 0 ok, 1 failure or missing script, 2 invalid arguments.`);
    return 0;
  }
  const [action, app, ...flags] = args;
  const invalid = (): number => {
    console.error(`error: invalid fleet app arguments\n${usage}`);
    return 2;
  };
  // A leading dash would land in the script's option slot (argparse), not the
  // app slot: `--automatic` as a name must never reach the script.
  if (!action || !ACTIONS.has(action) || !app || !APP_NAME.test(app) || app.startsWith('-')) return invalid();
  let root = join(homedir(), '.ashlr-runs');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i]!;
    if (seen.has(arg) || !['--json', '--root'].includes(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') json = true;
    else {
      const value = flags[++i];
      if (!value || value.startsWith('-')) {
        console.error(`error: --root needs a directory\n${usage}`);
        return 2;
      }
      root = value;
    }
  }
  const script = (deps.locateScript ?? findAppControlScript)();
  if (script === null) {
    console.error('fleet app: app control needs a Phantom source checkout (scripts/mac-bridge/app_control.py is not installed with the package)');
    return 1;
  }
  const exec = deps.exec ?? runAppControl;
  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec('python3', ['-I', script, action, app, '--output-dir', root], {
      encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
    }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
    if (e.killed === true || typeof e.signal === 'string') {
      console.error('error: fleet app timed out after 30s');
      return 1;
    }
    if (typeof e.code !== 'number') {
      console.error('error: fleet app could not start python3');
      return 1;
    }
    code = e.code;
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
  if (!record(parsed)) {
    // The contract is one JSON object; child stderr may carry host detail and
    // is never echoed.
    console.error('error: fleet app: app control failed without a readable result');
    return code === 0 ? 1 : code;
  }
  if (json) process.stdout.write(stdout);
  else console.log(formatFleetAppResult(parsed, app));
  return code;
}
