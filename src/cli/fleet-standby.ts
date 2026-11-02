/** Read-only standby takeover verdict via scripts/mac-bridge/standby_readiness.py. */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findBridgeSource } from '../core/fleet/bridge-install.js';

const execFileAsync = promisify(execFile);

const usage = 'Usage: ashlr fleet standby --db <lease.sqlite> --snapshot-store <dir> --primary <host> --role <name> --host <standby> [--max-age <60-86400>] [--json]';
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REQUIRED = ['--db', '--snapshot-store', '--primary', '--role', '--host'] as const;
const VALUE_FLAGS = new Set([...REQUIRED, '--max-age']);
const TIMEOUT_MS = 30_000;

export interface FleetStandbyExecOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  env?: NodeJS.ProcessEnv;
}
export type FleetStandbyExec =
  (file: string, argv: readonly string[], options: FleetStandbyExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface FleetStandbyDeps {
  exec?: FleetStandbyExec;
  locateScript?: () => string | null | Promise<string | null>;
}

/** execFile, never a shell; argv is a fixed vector so caller text never enters a command line. */
const runStandbyReadiness: FleetStandbyExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

function regularFile(path: string): string | null {
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Installed release first (~/.ashlr-runs/mac-bridge/current), then this
 * checkout's scripts/mac-bridge; the npm package does not ship scripts/.
 */
export async function findStandbyReadinessScript(): Promise<string | null> {
  const installed = regularFile(
    join(homedir(), '.ashlr-runs', 'mac-bridge', 'current', 'standby_readiness.py'));
  if (installed) return installed;
  try {
    return regularFile(join(await findBridgeSource(), 'standby_readiness.py'));
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeSeconds(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} sec`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} days`;
}

/** At most three short sentences for humans; --json callers get the raw object. */
function formatStandbyReport(report: Record<string, unknown>): string {
  const age = typeof report.wouldLoseSec === 'number' ? report.wouldLoseSec : null;
  if (report.ready === true) {
    if (age === null) return 'Standby can take over. Snapshot age is unknown.';
    return `Standby can take over. Last snapshot is ${describeSeconds(age)} old, so up to ${describeSeconds(age)} of work would be lost.`;
  }
  const blockers = Array.isArray(report.blockers)
    ? report.blockers.filter((blocker): blocker is string => typeof blocker === 'string')
    : [];
  const parts = [`Standby cannot take over: ${blockers[0] ?? 'unknown'}.`];
  if (age !== null) parts.push(`Last snapshot is ${describeSeconds(age)} old.`);
  if (blockers.length > 1) parts.push(`${blockers.length - 1} more blocker(s) — rerun with --json for the list.`);
  return parts.join(' ');
}

export async function cmdFleetStandby(args: string[], deps: FleetStandbyDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nReport whether the standby could take over this role now and how much work would be lost, from the lease database and the newest verified snapshot. Strictly read-only: never acquires or releases the lease, writes the store, restores a snapshot, or starts a process. Exit 0 prints the report whether or not the standby is ready, 1 missing script or unreadable result, 2 invalid arguments.`);
    return 0;
  }
  const invalid = (): number => {
    console.error(`error: invalid fleet standby arguments\n${usage}`);
    return 2;
  };
  let json = false;
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || (arg !== '--json' && !VALUE_FLAGS.has(arg))) return invalid();
    seen.add(arg);
    if (arg === '--json') {
      json = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) return invalid();
    values.set(arg, value);
  }
  for (const required of REQUIRED) {
    if (!values.has(required)) {
      console.error(`error: fleet standby needs ${required}\n${usage}`);
      return 2;
    }
  }
  for (const name of ['--primary', '--role', '--host'] as const) {
    if (!IDENTITY.test(values.get(name)!)) return invalid();
  }
  let maxAge: number | undefined;
  const rawMaxAge = values.get('--max-age');
  if (rawMaxAge !== undefined) {
    if (!/^\d+$/.test(rawMaxAge)) return invalid();
    maxAge = Number(rawMaxAge);
    if (maxAge < 60 || maxAge > 86400) return invalid();
  }
  const script = await (deps.locateScript ?? findStandbyReadinessScript)();
  if (script === null) {
    console.error('fleet standby: needs scripts/mac-bridge/standby_readiness.py — run ashlr fleet bridge-install --apply or use a Phantom source checkout');
    return 1;
  }
  const argv = ['-B', script,
    '--db', values.get('--db')!,
    '--snapshot-store', values.get('--snapshot-store')!,
    '--primary', values.get('--primary')!,
    '--role', values.get('--role')!,
    '--host', values.get('--host')!];
  if (maxAge !== undefined) argv.push('--max-age', String(maxAge));
  const exec = deps.exec ?? runStandbyReadiness;
  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec('python3', argv, {
      encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
    }));
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
    if (e.killed === true || typeof e.signal === 'string') {
      console.error('error: fleet standby timed out after 30s');
      return 1;
    }
    if (typeof e.code !== 'number') {
      console.error('error: fleet standby could not start python3');
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
    console.error('error: fleet standby: readiness check failed without a readable result');
    return code === 0 ? 1 : code;
  }
  if (json) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
  else console.log(formatStandbyReport(parsed));
  return code;
}
