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
/**
 * RQ-QUEUE-BATCH-1: dispatchd adapts the fleet cap every tick (contrib/mac/concurrency.py, queue/concurrency.json);
 * the fixed 18 is gone. A top-level slots.json hard_cap is an optional operator ceiling; a malformed one fails
 * closed to this legacy value, as dispatchd does.
 */
export const LEGACY_GLOBAL_HARD_CAP = 18;
const STATUS_TIMEOUT_MS = 30_000;

export interface InstallLockHolder { pid: number; job?: string; command?: string; since?: number }
export interface AdmissionInput {
  load1: number; ncpu: number; procs: number; worktrees: number;
  /** Seconds since the ashlr daemon's lastTickAt, or null when unknown. */
  daemonTickAgeS: number | null; daemonWhy?: string | null;
  slots: Record<string, unknown>; running: number; holder: InstallLockHolder | null; disabled?: boolean;
  /** dispatchd's adaptive cap from queue/concurrency.json, or null on hosts that have not run the controller. */
  adaptiveCap?: number | null;
}
export interface AdmissionReport {
  snapshot?: Record<string, unknown>;
  admit: boolean; reason: string | null; reasons: string[]; disabled: boolean;
  load: { load1: number; max: number }; ncpu: number; procs: number; worktrees: number;
  daemon: { tickAgeSeconds: number | null; maxAgeSeconds: number; error: string | null };
  cap: number; hardCap: number | null; adaptiveCap: number | null; running: number; installLock: { holder: InstallLockHolder | null };
  /** Set when an admission.v2 snapshot exists but is missing its `ts` or older than DAEMON_TICK_MAX_S; the report then comes from live probes. */
  staleSnapshot?: { ts: string | null; ageSeconds: number | null };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * min(sum of unheld lane targets, adaptive cap, operator hard_cap); a lane target is itself bounded by that lane's
 * hard_cap. Hosts without controller state keep the legacy ncpu bound in place of the adaptive cap.
 */
export function globalCap(slots: Record<string, unknown>, ncpu: number, adaptiveCap: number | null = null): { cap: number; hardCap: number | null } {
  const hardCap = !('hard_cap' in slots) ? null : isCount(slots.hard_cap) ? slots.hard_cap : LEGACY_GLOBAL_HARD_CAP;
  let sum = 0;
  for (const [lane, value] of Object.entries(slots)) {
    if (GLOBAL_SLOT_KEYS.has(lane) || typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    if (row.held === true || !isCount(row.target)) continue;
    sum += isCount(row.hard_cap) ? Math.min(row.target, row.hard_cap) : row.target;
  }
  return { cap: Math.max(0, Math.min(sum, adaptiveCap ?? ncpu, hardCap ?? Infinity)), hardCap };
}

export function evaluateAdmission(input: AdmissionInput): AdmissionReport {
  const loadMax = Math.min(2 * input.ncpu, LOAD_MAX);
  const reasons: string[] = [];
  if (!(input.load1 <= loadMax)) reasons.push(`loadavg ${input.load1.toFixed(1)} > ${loadMax.toFixed(1)}`);
  if (input.procs > PROCS_MAX) reasons.push(`procs ${input.procs} > ${PROCS_MAX}`);
  if (input.worktrees > WORKTREES_MAX) reasons.push(`worktrees ${input.worktrees} > ${WORKTREES_MAX}`);
  if (input.daemonTickAgeS === null) reasons.push(`daemon_status_unavailable (${input.daemonWhy ?? 'unknown'})`);
  else if (input.daemonTickAgeS > DAEMON_TICK_MAX_S) reasons.push(`daemon_tick_stale ${Math.floor(input.daemonTickAgeS)}s > ${DAEMON_TICK_MAX_S}s`);
  const adaptiveCap = input.adaptiveCap ?? null;
  const { cap, hardCap } = globalCap(input.slots, input.ncpu, adaptiveCap);
  const disabled = input.disabled === true;
  const tripped = reasons.length > 0 && !disabled;
  const blockers = tripped ? [...reasons] : [];
  if (input.running >= cap) blockers.push(`at_cap running ${input.running} >= cap ${cap}`);
  const blocked = blockers.length > 0;
  return {
    admit: !blocked, reason: blocked ? blockers.join('; ') : null, reasons, disabled,
    load: { load1: input.load1, max: loadMax }, ncpu: input.ncpu, procs: input.procs, worktrees: input.worktrees,
    daemon: { tickAgeSeconds: input.daemonTickAgeS, maxAgeSeconds: DAEMON_TICK_MAX_S, error: input.daemonWhy ?? null },
    cap, hardCap, adaptiveCap, running: input.running, installLock: { holder: input.holder },
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
  // v2 is the dispatcher verdict, including starvation probes and its rolling swap window.
  // Keep the legacy probe path for hosts that have not installed the pinned dispatcher yet.
  const now = (opts.now ?? Date.now)();
  let staleSnapshot: AdmissionReport['staleSnapshot'];
  try {
    const a = JSON.parse(await text(join(queue, 'admission.json')) ?? '{}') as Record<string, unknown>;
    // dispatchd rewrites the snapshot every tick. One it stopped refreshing is a dead dispatcher's last
    // verdict (with its tick age frozen at write time), so it must not be reported as the current decision.
    const ts = typeof a.ts === 'string' ? a.ts : null;
    const writtenAt = ts === null ? NaN : Date.parse(ts);
    // A timestamp far ahead of this clock proves nothing about freshness either.
    const rawAgeS = (now - writtenAt) / 1000;
    const fresh = Number.isFinite(rawAgeS) && Math.abs(rawAgeS) <= DAEMON_TICK_MAX_S;
    const ageSeconds = Number.isFinite(rawAgeS) ? Math.max(0, rawAgeS) : null;
    if (a.schema === 'dispatchd.admission.v2' && typeof a.admit === 'boolean' && !fresh) staleSnapshot = { ts, ageSeconds };
    if (a.schema === 'dispatchd.admission.v2' && typeof a.admit === 'boolean' && fresh) return {
      admit: a.admit, reason: typeof a.reason === 'string' ? a.reason : null,
      reasons: Array.isArray(a.reasons) ? a.reasons as string[] : [], disabled: a.disabled === true,
      load: { load1: Number(a.load1), max: Number(a.load_max) }, ncpu: Number(a.ncpu),
      procs: Number(a.procs), worktrees: Number(a.worktrees),
      daemon: { tickAgeSeconds: typeof a.daemon_tick_age_s === 'number' ? a.daemon_tick_age_s : null,
        maxAgeSeconds: Number(a.tick_max_s), error: null },
      cap: Number(a.cap), hardCap: isCount(a.hard_cap) ? a.hard_cap : null,
      adaptiveCap: isCount(a.concurrency_cap) ? a.concurrency_cap : null, running: Number(a.running),
      installLock: { holder: a.install_lock_holder as InstallLockHolder | null }, snapshot: a,
    };
  } catch { /* Older hosts use the legacy probes below. */ }
  const alive = opts.pidAlive ?? defaultAlive;

  let slots: Record<string, unknown> = {};
  try { const raw = JSON.parse(await text(join(queue, 'slots.json')) ?? '{}'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) slots = raw; } catch { /* unreadable: cap 0 */ }

  let adaptiveCap: number | null = null;
  try {
    const c = JSON.parse(await text(join(queue, 'concurrency.json')) ?? '{}') as Record<string, unknown>;
    if (c.schema === 'dispatchd.concurrency.v1' && isCount(c.cap)) adaptiveCap = c.cap;
  } catch { /* no controller state: legacy ncpu bound */ }

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

  const report = evaluateAdmission({
    load1: (opts.load1 ?? (() => loadavg()[0]!))(), ncpu: (opts.ncpu ?? availableParallelism)(),
    procs, worktrees, daemonTickAgeS, daemonWhy, slots, running, holder, adaptiveCap, disabled: await exists(join(queue, 'LOADGATE_OFF')),
  });
  return staleSnapshot ? { ...report, staleSnapshot } : report;
}
