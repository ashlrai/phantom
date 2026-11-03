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
  /** Optional abort signal.  When pre-aborted at entry, no discovery/probe/sleep
   *  calls are made and the command exits 4 with outcome 'cancelled' immediately.
   *  Aborting mid-loop cancels the current step and prevents further probes. */
  signal?: AbortSignal;
}

type Report = Record<string, unknown>;
type Raced<T> =
  | { kind: 'value';   value: T }
  | { kind: 'failed'  }
  | { kind: 'deadline'}
  | { kind: 'cancelled'};

/** Wall-timer + one-shot abort listener around a promise.
 *  Clears both on settle so the work's rejection is never unhandled. */
function bounded<T>(
  work: () => Promise<T>, deadlineMs: number, signal?: AbortSignal,
): Promise<Raced<T>> {
  return new Promise(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Raced<T>): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => finish({ kind: 'cancelled' });
    if (signal?.aborted) return finish({ kind: 'cancelled' });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: 'deadline' }), Math.max(0, deadlineMs));
    let p: Promise<T>;
    try { p = Promise.resolve(work()); } catch { return finish({ kind: 'failed' }); }
    p.then(v => finish({ kind: 'value', value: v }), () => finish({ kind: 'failed' }));
  });
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
    console.log(`${usage}\nProbe the standby readiness proof (the same check as ashlr fleet standby) now and then every interval until it reports ready with no blockers or the total deadline passes. Observes only: never takes the lease, restores, starts workers or changes config. Aborting via \`signal\` cancels mid-loop; pre-aborted signals skip all work. Exit 0 ready, 3 deadline elapsed (last report shown), 4 aborted via signal, 1 execution or invalid-output failure, 2 invalid arguments.`);
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
  const signal = deps.signal;
  let attempts = 0;
  let lastReport: Report | null = null;
  const finish = (outcome: 'ready' | 'timeout' | 'cancelled' | 'error', code: number, line: string): number => {
    if (json) {
      process.stdout.write(`${JSON.stringify({ outcome, attempts, elapsedMs: Math.max(0, now() - start), lastReport })}\n`);
    } else if (code === 0) console.log(line);
    else console.error(line);
    return code;
  };

  // Pre-abort: zero calls, exit 4 immediately.
  if (signal?.aborted) return finish('cancelled', 4, 'Standby-await aborted.');

  // Discovery is bounded by the total budget and the abort signal.
  const scriptResult = await bounded(async () => {
    return (deps.locateScript ?? findStandbyReadinessScript)();
  }, timeoutMs, signal);
  if (scriptResult.kind === 'cancelled') return finish('cancelled', 4, 'Standby-await aborted.');
  if (scriptResult.kind === 'deadline') {
    return finish('timeout', 3, 'Standby not ready before the deadline (no readable report).');
  }
  if (scriptResult.kind === 'failed') return finish('error', 1, 'error: fleet standby-await: readiness probe could not run');

  const script = scriptResult.value;
  if (script === null) return finish('error', 1, 'error: fleet standby-await needs scripts/mac-bridge/standby_readiness.py');
  const argv = ['-B', script];
  for (const flag of [...STANDBY_REQUIRED, '--max-age']) {
    if (values.has(flag)) argv.push(flag, values.get(flag)!);
  }

  for (;;) {
    const remaining = timeoutMs - (now() - start);
    if (remaining <= 0) break;
    if (signal?.aborted) return finish('cancelled', 4, 'Standby-await aborted.');
    const probeTimeout = Math.min(remaining, PROBE_CAP_MS);
    attempts++;
    let stdout = '';
    let killed = false;

    // Bound the exec call by the abort signal using a race pattern.
    // The exec call itself is handled inline to preserve stderr/config
    // privacy and the existing error-extraction logic.  We wrap it
    // in a bounded-race on the abort signal so that if the signal
    // fires mid-exec, the exec is killed by its timeout and we
    // return early (no extra probes start after cancellation).
    let execDone = false;
    let aborted = false;
    function abortNow(): void {
      if (execDone) return;
      aborted = true;
      signal?.removeEventListener('abort', abortNow);
    }
    signal?.addEventListener('abort', abortNow, { once: true });
    try {
      ({ stdout } = await exec('python3', argv, {
        encoding: 'utf8', timeout: probeTimeout, maxBuffer: 1024 * 1024, windowsHide: true,
      }));
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
      killed = e.killed === true || typeof e.signal === 'string';
      // A readable report on a non-zero exit is still a report; no stderr is ever read.
      if (killed || typeof e.code !== 'number') stdout = '';
      else stdout = typeof e.stdout === 'string' ? e.stdout : '';
      if (killed && probeTimeout < PROBE_CAP_MS) break; // killed by the remaining budget: deadline, not a fault
      if (killed || typeof e.code !== 'number') { execDone = true; return finish('error', 1, 'error: fleet standby-await: readiness probe could not run'); }
    }
    execDone = true;
    signal?.removeEventListener('abort', abortNow);

    let report: Report | null = null;
    try { report = validReport(JSON.parse(stdout)); } catch { report = null; }
    if (!report) return finish('error', 1, 'error: fleet standby-await: readiness probe returned no valid report');
    lastReport = report;
    if (report.ready === true) return finish('ready', 0, 'Standby is ready to take over.');
    const left = timeoutMs - (now() - start);
    if (left <= 0) break;
    const sleepResult = await bounded(async () => {
      await sleep(Math.min(intervalMs, left));
    }, left, signal);
    if (sleepResult.kind === 'cancelled') return finish('cancelled', 4, 'Standby-await aborted.');
  }
  // Blocker codes are echoed only when they look like codes; child text never reaches the terminal raw.
  const codes = lastReport ? (lastReport.blockers as string[]).filter((b) => /^[a-z0-9-]{1,40}$/.test(b)) : [];
  const blockers = codes.length > 0 ? codes.join(', ') : 'no readable report';
  return finish('timeout', 3, `Standby not ready before the deadline (${blockers}).`);
}
