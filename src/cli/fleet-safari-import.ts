/** Explicit bounded bridge to scripts/mac-bridge/safari_import.py (RQ-PHX-SAFARIIMPORTVERB01). */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const usage = `Usage: ashlr fleet safari-import <status|begin-import> [--root <dir>] [--timeout <1-120>] [--json]
Drives scripts/mac-bridge/safari_import.py (python3 -I, never a shell) to check or
open Safari's built-in File > Import From > Google Chrome dialog. --root names the
runs root under which supervisor/NEEDS-MASON.md receives any block line (default
~/.ashlr-runs); it is always passed to the helper as an absolute path. The helper
is killed --timeout + 15s after launch. With --json the helper's JSON result
prints unchanged and its exit code propagates: 2 means blocked on a human step,
which is a normal result. Safari, Keychain and the import itself stay with macOS
and the operator.`;
const MODES = new Set(['status', 'begin-import']);
const DEFAULT_TIMEOUT_SECONDS = 15;
/** Grace the child gets past its own --timeout before the bound kills it. */
const KILL_GRACE_MS = 15_000;

export interface SafariImportExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}
export type SafariImportExec =
  (file: string, argv: readonly string[], options: SafariImportExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface SafariImportDeps {
  exec?: SafariImportExec;
  locateScript?: () => string | null;
}

/** execFile, never a shell; argv is a fixed vector so caller text never enters a command line. */
const runSafariImport: SafariImportExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

/**
 * Nearest ancestor of this module carrying scripts/mac-bridge/safari_import.py.
 * The npm package does not ship scripts/, so the walk stops at the first
 * ancestor containing package.json and reports absence instead of adopting a
 * script that merely shares the path somewhere above the install root.
 */
export function findSafariImportScript(from: string = fileURLToPath(import.meta.url)): string | null {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'scripts', 'mac-bridge', 'safari_import.py');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const obj = (value: unknown): Record<string, unknown> | undefined => record(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

/**
 * One short line for humans; --json callers get the helper's raw output instead.
 * An open dialog is never a finished import: importConfirmed/websitesSignedIn
 * are only reported when the helper itself asserts them.
 */
function formatSafariImportResult(mode: string, result: Record<string, unknown>, code: number): string {
  const blocked = obj(result['blocked']);
  const next = str(result['nextAction']);
  if (blocked) {
    const reason = str(blocked['reason']) ?? 'unknown';
    const detail = str(blocked['detail']);
    const noted = str(obj(result['needsMason'])?.['path']);
    return `safari-import ${mode}: blocked: ${reason}${detail ? ` — ${detail}` : ''}.` +
      `${noted ? ` (noted in ${noted})` : ''}${next ? ` Next: ${next}` : ''}`;
  }
  const bits: string[] = [];
  const safari = obj(result['safari']);
  if (safari?.['launched'] === true) bits.push('safari launched');
  else if (safari && 'running' in safari) bits.push(`safari ${safari['running'] === true ? 'running' : 'not running'}`);
  const menu = obj(result['menu']);
  if (menu) {
    bits.push(menu['importFromPresent'] === true
      ? `chrome item: ${str(menu['chromeItem']) ?? 'none'}` : 'no Import From menu');
  }
  const dialog = obj(result['dialog']);
  if (dialog?.['opened'] === true || dialog?.['alreadyOpen'] === true) {
    bits.push(`import dialog ${dialog['opened'] === true ? 'opened' : 'already open'} in Safari — the operator still finishes the import there`);
  } else if (str(dialog?.['state'])) bits.push(`import dialog: ${dialog!['state']}`);
  if (result['keychainPrompt'] === true) bits.push('keychain prompt pending');
  const acc = obj(result['accessibility']);
  if (acc) {
    bits.push(acc['ready'] === true ? 'accessibility ready'
      : `accessibility not ready${str(acc['reason']) ? ` (${acc['reason']})` : ''}`);
  }
  if (str(result['error'])) bits.push(`error: ${result['error']}`);
  if (result['importConfirmed'] === true) bits.push('import confirmed');
  if (result['websitesSignedIn'] === true) bits.push('websites signed in');
  return `safari-import ${mode}: ${bits.length > 0 ? bits.join('; ') : `helper exited ${code}`}.${next ? ` Next: ${next}` : ''}`;
}

export async function cmdFleetSafariImport(args: string[], deps: SafariImportDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const invalid = (): number => {
    console.error(`error: invalid fleet safari-import arguments\n${usage.split('\n')[0]}`);
    return 2;
  };
  let json = false;
  let root: string | undefined;
  let timeout: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--root' && root === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return invalid();
      root = value;
    } else if (arg === '--timeout' && timeout === undefined) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 1 || value > 120) return invalid();
      timeout = value;
    } else if (arg.startsWith('-')) return invalid();
    else positional.push(arg);
  }
  // The mode is validated against the closed list before anything spawns.
  if (positional.length !== 1 || !MODES.has(positional[0]!)) return invalid();
  const mode = positional[0]!;

  const script = (deps.locateScript ?? findSafariImportScript)();
  if (script === null) {
    console.error('fleet safari-import: safari import needs a Phantom source checkout (scripts/mac-bridge/safari_import.py is not installed with the package)');
    return 1;
  }
  const timeoutSeconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = Math.round(timeoutSeconds * 1000) + KILL_GRACE_MS;
  // --needs-mason is always absolute; the helper's own relative default would
  // otherwise land a block line in the caller's cwd.
  const needsMason = resolve(root ?? join(homedir(), '.ashlr-runs'), 'supervisor', 'NEEDS-MASON.md');
  const exec = deps.exec ?? runSafariImport;
  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec('python3',
      ['-I', script, mode, '--needs-mason', needsMason, '--timeout', String(timeoutSeconds)],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
    if (e.killed === true || typeof e.signal === 'string') {
      console.error(`error: fleet safari-import timed out after ${Math.round(timeoutMs / 1000)}s`);
      return 1;
    }
    if (typeof e.code !== 'number') {
      console.error('error: fleet safari-import could not start python3');
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
    console.error('error: fleet safari-import: helper exited without a readable result');
    return 1;
  }
  if (json) process.stdout.write(stdout);
  else console.log(formatSafariImportResult(mode, parsed, code));
  return code;
}
