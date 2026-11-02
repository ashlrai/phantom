/**
 * Load-aware admission (RQ-LOADGATE-1): the read-only mirror of the gate in contrib/mac/dispatchd.py.
 * `phm pool admission` reports what dispatchd would decide right now. It never claims, launches or writes.
 * Keep the limits in step with GATE_* in dispatchd.py.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir, loadavg, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SLOT_KEYS } from '../fleet/runs-lane-targets.js';

export const LOAD_MAX = 36;
export const PROCS_MAX = 800;
export const WORKTREES_MAX = 40;
export const DAEMON_TICK_MAX_S = 15 * 60;
export const DEFAULT_GLOBAL_HARD_CAP = 18;
const STATUS_TIMEOUT_MS = 30_000;

export function usageVerdict(row: Record<string, unknown>, now: number, critical = false) {
  const used = row.weekly_used_pct;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) {
    return { admit: true, reason: 'usage unknown', used_fraction: null, elapsed_fraction: null, limit: null };
  }
  const reset = typeof row.reset_at === 'number' ? row.reset_at * 1000 : typeof row.reset_at === 'string' ? Date.parse(row.reset_at) : NaN;
  const week = 7 * 86400_000;
  const elapsed = Number.isFinite(reset) && now < reset && reset <= now + week ? Math.max(0, 1 - (reset - now) / week) : null;
  const limit = critical ? 0.95 : elapsed === null ? 0.60 : Math.min(1, elapsed + 0.10);
  const admit = used / 100 <= limit;
  return { admit, reason: `${critical ? 'critical reserve' : elapsed === null ? 'reset unknown: 60% fallback' : 'reset pacing'}: ${admit ? 'admit' : 'defer'}`,
    used_fraction: used / 100, elapsed_fraction: elapsed, limit };
}

export interface InstallLockHolder { pid: number; job?: string; command?: string; since?: number }
export interface AdmissionInput {
  load1: number; ncpu: number; procs: number; worktrees: number;
  /** Seconds since the ashlr daemon's lastTickAt, or null when unknown. */
  daemonTickAgeS: number | null; daemonWhy?: string | null;
  slots: Record<string, unknown>; running: number; holder: InstallLockHolder | null; disabled?: boolean;
}
export interface AdmissionReport {
  lanes?: Record<string, { routine: ReturnType<typeof usageVerdict>; critical: ReturnType<typeof usageVerdict> }>;
  admit: boolean; reason: string | null; reasons: string[]; disabled: boolean;
  load: { load1: number; max: number }; ncpu: number; procs: number; worktrees: number;
  daemon: { tickAgeSeconds: number | null; maxAgeSeconds: number; error: string | null };
  cap: number; hardCap: number; running: number; installLock: { holder: InstallLockHolder | null };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** min(sum of unheld lane targets, ncpu, global hard_cap); a lane target is itself bounded by that lane's hard_cap. */
export function globalCap(slots: Record<string, unknown>, ncpu: number): { cap: number; hardCap: number } {
  const hardCap = isCount(slots.hard_cap) ? slots.hard_cap : DEFAULT_GLOBAL_HARD_CAP;
  let sum = 0;
  for (const [lane, value] of Object.entries(slots)) {
    if (GLOBAL_SLOT_KEYS.has(lane) || typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    if (row.held === true || !isCount(row.target)) continue;
    sum += isCount(row.hard_cap) ? Math.min(row.target, row.hard_cap) : row.target;
  }
  return { cap: Math.max(0, Math.min(sum, ncpu, hardCap)), hardCap };
}

export function evaluateAdmission(input: AdmissionInput): AdmissionReport {
  const loadMax = Math.min(2 * input.ncpu, LOAD_MAX);
  const reasons: string[] = [];
  if (!(input.load1 <= loadMax)) reasons.push(`loadavg ${input.load1.toFixed(1)} > ${loadMax.toFixed(1)}`);
  if (input.procs > PROCS_MAX) reasons.push(`procs ${input.procs} > ${PROCS_MAX}`);
  if (input.worktrees > WORKTREES_MAX) reasons.push(`worktrees ${input.worktrees} > ${WORKTREES_MAX}`);
  if (input.daemonTickAgeS === null) reasons.push(`daemon_status_unavailable (${input.daemonWhy ?? 'unknown'})`);
  else if (input.daemonTickAgeS > DAEMON_TICK_MAX_S) reasons.push(`daemon_tick_stale ${Math.floor(input.daemonTickAgeS)}s > ${DAEMON_TICK_MAX_S}s`);
  const { cap, hardCap } = globalCap(input.slots, input.ncpu);
  const disabled = input.disabled === true;
  const tripped = reasons.length > 0 && !disabled;
  const blockers = tripped ? [...reasons] : [];
  if (input.running >= cap) blockers.push(`at_cap running ${input.running} >= cap ${cap}`);
  const blocked = blockers.length > 0;
  return {
    admit: !blocked, reason: blocked ? blockers.join('; ') : null, reasons, disabled,
    load: { load1: input.load1, max: loadMax }, ncpu: input.ncpu, procs: input.procs, worktrees: input.worktrees,
    daemon: { tickAgeSeconds: input.daemonTickAgeS, maxAgeSeconds: DAEMON_TICK_MAX_S, error: input.daemonWhy ?? null },
    cap, hardCap, running: input.running, installLock: { holder: input.holder },
  };
}

export interface ReadAdmissionOptions {
  runsDir?: string; now?: () => number;
  load1?: () => number; ncpu?: () => number;
  countProcesses?: () => Promise<number>;
  /** ISO lastTickAt from `ashlr daemon status --json`; reject or return null when unavailable. */
  daemonLastTickAt?: () => Promise<string | null>;
  pidAlive?: (pid: number) => boolean;
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const defaultProcs = async () => (await run('ps', ['-axo', 'pid='], 20_000)).split('\n').filter(l => l.trim()).length;
const defaultDaemon = async () => {
  const lastTickAt = (JSON.parse(await run('ashlr', ['daemon', 'status', '--json'], STATUS_TIMEOUT_MS)) as { lastTickAt?: unknown }).lastTickAt;
  return typeof lastTickAt === 'string' ? lastTickAt : null;
};
const defaultAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
async function text(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function readAdmission(opts: ReadAdmissionOptions = {}): Promise<AdmissionReport> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const queue = join(root, 'queue');
  const now = (opts.now ?? Date.now)();
  const alive = opts.pidAlive ?? defaultAlive;

  let slots: Record<string, unknown> = {};
  try { const raw = JSON.parse(await text(join(queue, 'slots.json')) ?? '{}'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) slots = raw; } catch { /* unreadable: cap 0 */ }

  let running = 0;
  try {
    const lanes = (JSON.parse(await text(join(queue, 'status.json')) ?? '{}') as { lanes?: Record<string, { running?: unknown }> }).lanes ?? {};
    for (const row of Object.values(lanes)) if (isCount(row?.running)) running += row.running;
  } catch { /* no status yet: nothing known to be running */ }

  let worktrees = 0;
  try {
    for (const name of (await readdir(root)).filter(n => n.endsWith('.base'))) {
      const fields = (await text(join(root, name)))?.split(/\s+/).filter(Boolean) ?? [];
      if (fields.length >= 4 && await exists(fields[2]!)) worktrees++;
    }
  } catch { /* no runs dir */ }

  let daemonTickAgeS: number | null = null; let daemonWhy: string | null = null;
  try {
    const at = await (opts.daemonLastTickAt ?? defaultDaemon)();
    const ms = at === null ? NaN : Date.parse(at);
    if (Number.isFinite(ms)) daemonTickAgeS = Math.max(0, (now - ms) / 1000); else daemonWhy = 'no lastTickAt';
  } catch (e) { daemonWhy = e instanceof Error ? e.constructor.name : 'error'; }

  let procs = 0;
  try { procs = await (opts.countProcesses ?? defaultProcs)(); } catch { procs = Number.POSITIVE_INFINITY; /* unreadable: fail closed */ }

  let holder: InstallLockHolder | null = null;
  try {
    const h = JSON.parse((await text(join(queue, 'install.lock')))?.trim() || 'null') as InstallLockHolder | null;
    if (h && Number.isInteger(h.pid) && h.pid > 0 && alive(h.pid)) holder = h;
  } catch { /* garbage content is no holder */ }

  let usage: Record<string, Record<string, unknown>> = {};
  try { usage = JSON.parse(await text(join(queue, 'budget-overrides.json')) ?? '{}') ?? {}; } catch { /* unknown usage */ }
  const lanes = Object.fromEntries(Object.keys(slots).filter(lane => !GLOBAL_SLOT_KEYS.has(lane)).map(lane => {
    const row = usage[lane] ?? {};
    return [lane, { routine: usageVerdict(row, now), critical: usageVerdict(row, now, true) }];
  }));
  return { lanes, ...evaluateAdmission({
    load1: (opts.load1 ?? (() => loadavg()[0]!))(), ncpu: (opts.ncpu ?? availableParallelism)(),
    procs, worktrees, daemonTickAgeS, daemonWhy, slots, running, holder, disabled: await exists(join(queue, 'LOADGATE_OFF')),
  }) };
}
