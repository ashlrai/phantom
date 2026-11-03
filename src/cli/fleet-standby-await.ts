/** Wait (finite deadline) for the existing standby readiness proof; observes only, never fails over. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  findStandbyReadinessScript, parseStandbyFlags, readStandbyConfig, STANDBY_REQUIRED,
  validateStandbyValues,
  type FleetStandbyDeps, type FleetStandbyExec,
} from './fleet-standby.js';

const execFileAsync = promisify(execFile);

const usage = 'Usage: ashlr fleet standby-await --timeout-ms <1-3600000> [--interval-ms <100-60000>] [--db <lease.sqlite> --snapshot-store <dir> --primary <host> --role <name> --host <standby> [--max-age <60-86400>]] [--json]';
const PROBE_CAP_MS = 30_000;
const WAIT_FLAGS = ['--timeout-ms', '--interval-ms'] as const;

export interface FleetStandbyAwaitDeps extends FleetStandbyDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Report = Record<string, unknown>;

/** Bound even dependencies that ignore their own timeout; consume late rejections. */
async function bounded<T>(operation: () => T | Promise<T>, ms: number): Promise<{ expired: true } | { expired: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then((value) => ({ expired: false as const, value })),
      new Promise<{ expired: true }>((resolve) => { timer = setTimeout(() => resolve({ expired: true }), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Same readiness contract the Python child emits; anything else fails closed. */
function validReport(value: unknown): Report | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Report;
  if (r.version !== 1 || typeof r.ready !== 'boolean') return null;
  if (!Array.isArray(r.blockers) || r.blockers.some((b) => typeof b !== 'string')) return null;
  if (r.ready !== (r.blockers.length === 0)) return null;
  if (r.wouldLoseSec !== null && (typeof r.wouldLoseSec !== 'number' || !Number.isFinite(r.wouldLoseSec))) return null;
  return r;
}

function intFlag(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** execFile, never a shell; argv is fixed. A non-zero exit still yields its stdout. */
const defaultExec: FleetStandbyExec = async (file, argv, options) => {
  const { stdout, stderr } = await execFileAsync(file, argv, options);
  return { stdout, stderr };
};

export async function cmdFleetStandbyAwait(args: string[], deps: FleetStandbyAwaitDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nProbe the standby readiness proof (the same check as ashlr fleet standby) now and then every interval until it reports ready with no blockers or the total deadline passes. Observes only: never takes the lease, restores, starts workers or changes config. Exit 0 ready, 3 deadline elapsed (last report shown), 1 execution or invalid-output failure, 2 invalid arguments.`);
    return 0;
  }
  const invalid = (): number => {
    console.error(`error: invalid fleet standby-await arguments\n${usage}`);
    return 2;
  };
  // Wait flags are split off first; the rest goes through the standby parser, which rejects unknown/duplicate flags.
  const rest: string[] = [];
  const wait = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!(WAIT_FLAGS as readonly string[]).includes(arg)) { rest.push(arg); continue; }
    const value = args[++i];
    if (wait.has(arg) || value === undefined || value.startsWith('--')) return invalid();
    wait.set(arg, value);
  }
  const parsed = parseStandbyFlags(rest);
  const timeoutMs = intFlag(wait.get('--timeout-ms'), 1, 3_600_000);
  const intervalMs = wait.has('--interval-ms') ? intFlag(wait.get('--interval-ms'), 100, 60_000) : 5000;
  if (!parsed || timeoutMs === null || intervalMs === null) return invalid();
  const json = parsed.flags.has('--json');
  let values = parsed.values;
  if (STANDBY_REQUIRED.every((flag) => !values.has(flag))) {
    const saved = readStandbyConfig(deps.runsDir);
    if (saved) {
      if (values.has('--max-age')) saved.set('--max-age', values.get('--max-age')!);
      values = saved;
    }
  }
  if (STANDBY_REQUIRED.some((flag) => !values.has(flag))) return invalid();
  const checked = validateStandbyValues(values);
  if (!checked) return invalid();

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const exec = deps.exec ?? defaultExec;
  const start = now();
  let attempts = 0;
  let lastReport: Report | null = null;
  const finish = (outcome: 'ready' | 'timeout' | 'error', code: number, line: string): number => {
    if (json) {
      process.stdout.write(`${JSON.stringify({ outcome, attempts, elapsedMs: Math.max(0, now() - start), lastReport })}\n`);
    } else if (code === 0) console.log(line);
    else console.error(line);
    return code;
  };

  const timeout = (): number => {
    const codes = lastReport ? (lastReport.blockers as string[]).filter((b) => /^[a-z0-9-]{1,40}$/.test(b)) : [];
    const blockers = codes.length > 0 ? codes.join(', ') : 'no readable report';
    return finish('timeout', 3, `Standby not ready before the deadline (${blockers}).`);
  };
  let discovery;
  try {
    discovery = await bounded(() => deps.locateScript ? deps.locateScript() : findStandbyReadinessScript(deps.runsDir), timeoutMs);
  } catch {
    if (now() - start >= timeoutMs) return timeout();
    return finish('error', 1, 'error: fleet standby-await: readiness script discovery failed');
  }
  if (discovery.expired || now() - start >= timeoutMs) return timeout();
  const script = discovery.value;
  if (script === null) return finish('error', 1, 'error: fleet standby-await needs scripts/mac-bridge/standby_readiness.py');
  const argv = ['-B', script];
  for (const flag of [...STANDBY_REQUIRED, '--max-age']) {
    if (values.has(flag)) argv.push(flag, values.get(flag)!);
  }

  for (;;) {
    const remaining = timeoutMs - (now() - start);
    if (remaining <= 0) break;
    const probeTimeout = Math.min(remaining, PROBE_CAP_MS);
    attempts++;
    let stdout = '';
    let killed = false;
    try {
      const result = await bounded(() => exec('python3', argv, {
        encoding: 'utf8', timeout: probeTimeout, maxBuffer: 1024 * 1024, windowsHide: true,
      }), probeTimeout);
      if (result.expired) {
        if (probeTimeout === remaining || now() - start >= timeoutMs) return timeout();
        return finish('error', 1, 'error: fleet standby-await: readiness probe could not run');
      }
      stdout = result.value.stdout;
      if (now() - start >= timeoutMs) return timeout();
    } catch (err) {
      if (now() - start >= timeoutMs) return timeout();
      const e = err as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
      killed = e.killed === true || typeof e.signal === 'string';
      // A readable report on a non-zero exit is still a report; no stderr is ever read.
      if (killed || typeof e.code !== 'number') stdout = '';
      else stdout = typeof e.stdout === 'string' ? e.stdout : '';
      if (killed && probeTimeout < PROBE_CAP_MS) break; // killed by the remaining budget: deadline, not a fault
      if (killed || typeof e.code !== 'number') return finish('error', 1, 'error: fleet standby-await: readiness probe could not run');
    }
    let report: Report | null = null;
    try { report = validReport(JSON.parse(stdout)); } catch { report = null; }
    if (!report) return finish('error', 1, 'error: fleet standby-await: readiness probe returned no valid report');
    lastReport = report;
    if (report.ready === true) return finish('ready', 0, 'Standby is ready to take over.');
    const left = timeoutMs - (now() - start);
    if (left <= 0) break;
    const pause = await bounded(() => sleep(Math.min(intervalMs, left)), left);
    if (pause.expired) return timeout();
  }
  return timeout();
}
