/**
 * Node self-measurement (RQ-NODE-AUTOSCALE-1, unit 1A).
 *
 * Reads CPU, memory, swap and per-harness session footprints from fixed
 * absolute macOS/Linux executables with bounded time and output. Never reads
 * process arguments, environment, credentials or app databases, never uses a
 * shell and makes no network calls. Every command failure becomes null.
 *
 * Process table: `/bin/ps` first (pid, ppid, rss, %cpu, short name). Some
 * sandboxed lanes are denied ps; on macOS they fall back to `pgrep -l .` for
 * short names, `pgrep -P` for each harness tree and `footprint` for physical
 * footprint per process (no CPU column there, see capacity-model.ts).
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { parseMemoryPressure, parseVmStat } from '../../resources/telemetry-parsers.js';
import { parseSwapUsage } from '../../run/host-headroom.js';
import { childrenFromRows, harnessFor, harnessSessions, type ProcessRow } from './harness-adapters.js';
import type { NodeSnapshot, ProcessSource } from './capacity-model.js';

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string | null>;

export interface MeasureHost {
  platform: string;
  now: () => number;
  hostname: () => string;
  cpus: () => os.CpuInfo[];
  loadavg: () => number[];
  totalmem: () => number;
  freemem: () => number;
  run: CommandRunner;
  sleep: (ms: number) => Promise<void>;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

const defaultMeasureHost: MeasureHost = {
  platform: process.platform, now: Date.now, hostname: os.hostname, cpus: os.cpus, loadavg: os.loadavg,
  totalmem: os.totalmem, freemem: os.freemem,
  run: (file, args, timeoutMs) => new Promise(resolve => {
    // Node throws EPERM (a sandbox denying ps, for example) synchronously from spawn.
    try {
      execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout));
    } catch { resolve(null); }
  }),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

export interface MeasureOptions {
  host?: MeasureHost;
  /** Node id written to the document; defaults to the short host name. */
  node?: string;
  /** CPU utilisation window. */
  cpuWindowMs?: number;
  /** Parallel footprint probes on the fallback path. */
  footprintConcurrency?: number;
}

/** `ps -axo pid=,ppid=,rss=,%cpu=,ucomm=`; ucomm is last because it may contain spaces. */
export function parsePsRows(text: string | null): ProcessRow[] | null {
  if (!text?.trim()) return null;
  const rows: ProcessRow[] = [];
  for (const line of text.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line);
    if (!m) return null;
    const rss = Number(m[3]) * 1024, cpu = Number(m[4]);
    if (!Number.isSafeInteger(rss) || !Number.isFinite(cpu)) return null;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[5]!, memBytes: rss, cpuPercent: cpu });
  }
  return rows;
}

/** `pgrep -l .` lines: "<pid> <name>". */
export function parsePgrepList(text: string | null): Array<{ pid: number; name: string }> | null {
  if (text === null) return null;
  const out: Array<{ pid: number; name: string }> = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), name: m[2]! });
  }
  return out;
}

function parsePids(text: string | null): number[] {
  return (text ?? '').split('\n').map(s => Number(s.trim())).filter(n => Number.isSafeInteger(n) && n > 0);
}

/** `footprint --noCategories -f bytes -p <pid>` reports "phys_footprint: <n> B". */
export function parseFootprint(text: string | null): number | null {
  const m = text?.match(/phys_footprint:\s+(\d+) B\b/) ?? text?.match(/Footprint:\s+(\d+) B\b/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `vm_stat` cumulative swapouts counter (memguard's growth signal). */
export function parseSwapouts(text: string | null): number | null {
  const n = Number(text?.match(/^Swapouts:\s+(\d+)\./m)?.[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `sysctl vm.swapusage` total, in bytes. */
export function parseSwapTotal(text: string | null): number | null {
  const m = text?.match(/total = ([\d.]+)([KMGT])/);
  if (!m) return null;
  const n = Number(m[1]) * 1024 ** ('KMGT'.indexOf(m[2]!) + 1);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function cpuBusyPercent(before: os.CpuInfo[], after: os.CpuInfo[]): number | null {
  if (!before.length || before.length !== after.length) return null;
  let total = 0, idle = 0;
  for (let i = 0; i < before.length; i++) {
    const t = (c: os.CpuInfo) => c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    total += t(after[i]!) - t(before[i]!);
    idle += after[i]!.times.idle - before[i]!.times.idle;
  }
  return total > 0 && idle >= 0 && idle <= total ? (total - idle) / total * 100 : null;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/** macOS fallback when ps is denied: harness trees only, physical footprint per process. */
async function pgrepFootprintRows(io: MeasureHost, concurrency: number): Promise<{ rows: ProcessRow[]; children: Map<number, number[]> } | null> {
  const list = async () => parsePgrepList(await io.run('/usr/bin/pgrep', ['-l', '.'], 5_000));
  const listed = await list();
  if (!listed?.length) return null;
  const names = new Map(listed.map(r => [r.pid, r.name]));
  const children = new Map<number, number[]>();
  const members = new Set<number>(listed.filter(r => harnessFor(r.name)).map(r => r.pid));
  // Breadth-first, one `pgrep -P <pid>` per member so every child keeps its parent.
  let frontier = [...members];
  for (let depth = 0; frontier.length && depth < 16; depth++) {
    const found = await pool(frontier, concurrency, async pid => parsePids(await io.run('/usr/bin/pgrep', ['-P', String(pid)], 5_000)));
    const next: number[] = [];
    frontier.forEach((pid, i) => {
      children.set(pid, found[i]!);
      for (const child of found[i]!) if (!members.has(child)) { members.add(child); next.push(child); }
    });
    frontier = next;
  }
  const pids = [...members].sort((a, b) => a - b);
  const mems = await pool(pids, concurrency, async pid =>
    parseFootprint(await io.run('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', '-p', String(pid)], 20_000)));
  // A process that exited during the probe is dropped; one still alive but unreadable stays null,
  // which leaves its harness unmeasured instead of under-counted.
  const alive = new Set((await list())?.map(r => r.pid) ?? []);
  const rows: ProcessRow[] = [];
  pids.forEach((pid, i) => {
    if (mems[i] === null && !alive.has(pid)) return;
    rows.push({ pid, ppid: null, name: names.get(pid) ?? '?', memBytes: mems[i] ?? null, cpuPercent: null });
  });
  return { rows, children };
}

/** One full measurement. CPU busy % is sampled over `cpuWindowMs` (default 1s). */
export async function measureNode(options: MeasureOptions = {}): Promise<NodeSnapshot> {
  const io = options.host ?? defaultMeasureHost;
  const mac = io.platform === 'darwin';
  const before = io.cpus();
  const [ps, vm, pressure, level, swap] = await Promise.all([
    io.run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,ucomm='], 5_000),
    mac ? io.run('/usr/bin/vm_stat', [], 5_000) : Promise.resolve(null),
    mac ? io.run('/usr/bin/memory_pressure', ['-Q'], 5_000) : Promise.resolve(null),
    mac ? io.run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], 5_000) : Promise.resolve(null),
    mac ? io.run('/usr/sbin/sysctl', ['vm.swapusage'], 5_000) : Promise.resolve(null),
  ]);
  let source: ProcessSource = 'unavailable';
  let sessions: NodeSnapshot['sessions'] = null;
  const psRows = parsePsRows(ps);
  if (psRows) {
    source = 'ps';
    sessions = harnessSessions(psRows, childrenFromRows(psRows));
  } else if (mac) {
    const fallback = await pgrepFootprintRows(io, options.footprintConcurrency ?? 12);
    if (fallback) { source = 'pgrep+footprint'; sessions = harnessSessions(fallback.rows, fallback.children); }
  }
  await io.sleep(Math.max(0, (options.cpuWindowMs ?? 1_000)));
  const after = io.cpus();
  const totalBytes = io.totalmem();
  const vmFree = parseVmStat(vm)?.freeBytes ?? null;
  const pctRaw = Number(pressure?.match(/System-wide memory free percentage:\s*(\d+)%/i)?.[1]);
  const lvl = parseMemoryPressure(`level: ${level?.trim() ?? ''}`);
  const swapGb = swap ? parseSwapUsage(swap) : null;
  const load = io.loadavg();
  return {
    node: options.node ?? io.hostname().replace(/\.local$/, ''),
    measuredAtMs: io.now(),
    platform: io.platform,
    cpu: { cores: after.length, load: load.length === 3 && load.every(Number.isFinite) ? [load[0]!, load[1]!, load[2]!] : null,
      busyPercent: cpuBusyPercent(before, after) },
    mem: {
      totalBytes,
      freeBytes: mac ? vmFree : io.freemem(),
      freePercent: Number.isFinite(pctRaw) && pctRaw >= 0 && pctRaw <= 100 ? pctRaw : null,
      // Linux has no kernel level here; unknown keeps every harness at null (fail closed).
      pressureLevel: lvl === 'normal' ? 1 : lvl === 'warning' ? 2 : lvl === 'critical' ? 4 : null,
    },
    swap: { usedBytes: swapGb === null ? null : Math.round(swapGb * 1024 ** 3), totalBytes: parseSwapTotal(swap), swapoutsTotal: parseSwapouts(vm) },
    processSource: source,
    sessions,
  };
}

