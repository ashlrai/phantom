/** Opt-in, local-only machine telemetry. No shell, sudo, network or process arguments. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import type { CpuInfo } from 'node:os';
import {
  parseAccelerators, parseDisks, parseLinuxMemory, parseMacSwap, parseMemoryPressure,
  parsePs, parseQueueStatus, parseVmStat, sumJobTrees,
  type JobReading, type MemoryPressure,
} from './telemetry-parsers.js';

export interface MachineTelemetryConfig { enabled?: boolean; estimatedJobRssBytes?: number }
export interface MachineTelemetry {
  schemaVersion: 1;
  sampledAtMs: number;
  platform: string;
  durationMs: number;
  cpu: { perCore: Array<{ totalMs: number; idleMs: number; usedPercent: number | null }>; loadAverage: number[] };
  ram: { totalBytes: number | null; usedBytes: number | null; freeBytes: number | null };
  swap: { usedBytes: number | null; growthBytesPerSecond: number | null };
  memoryPressure: { level: MemoryPressure; freePercent: number | null; pageouts: number | null };
  disks: ReturnType<typeof parseDisks>;
  gpuPercent: number | null;
  anePercent: number | null;
  jobs: JobReading[];
  queueState: 'known' | 'unknown';
  memguardPaused: boolean | null;
  estimatedJobRssBytes: number;
  headroom: number;
}
export interface TelemetryHost {
  platform: string;
  now: () => number;
  cpus: () => CpuInfo[];
  totalmem: () => number;
  freemem: () => number;
  loadavg: () => number[];
  read: (file: string) => Promise<string | null>;
  command: (file: string, args: string[]) => Promise<string | null>;
}
export interface SampleMachineOptions {
  host?: TelemetryHost;
  previous?: MachineTelemetry | null;
  statusPath?: string;
  estimatedJobRssBytes?: number;
}
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RSS = 1024 ** 3;

/** Read only bounded regular files, without following a final symlink. */
export async function readTelemetryFile(file: string): Promise<string | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead > MAX_BYTES ? null : buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch { return null; }
}

const host: TelemetryHost = {
  platform: process.platform, now: Date.now, cpus: os.cpus, totalmem: os.totalmem, freemem: os.freemem, loadavg: os.loadavg,
  read: readTelemetryFile,
  command: (file, args) => new Promise(resolve => {
    // Commands run concurrently under the same small budget. Error output is never logged.
    execFile(file, args, { timeout: 100, killSignal: 'SIGKILL', maxBuffer: MAX_BYTES,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout));
  }),
};

/** Reserve 25% of available memory. Unknown growth and unknown jobs fail closed. */
export function machineHeadroom(freeBytes: number | null, growth: number | null, paused: boolean | null,
  rssPerSlot: number, jobs: JobReading[]): number {
  if (paused !== false || growth !== 0 || freeBytes === null || !Number.isFinite(freeBytes) || freeBytes < 0 ||
      !Number.isSafeInteger(rssPerSlot) || rssPerSlot <= 0 || jobs.some(job => job.rssBytes === null)) return 0;
  return Math.max(0, Math.floor(freeBytes * 0.75 / rssPerSlot));
}

/** A single no-wait sample; deltas use a prior observation rather than sleeping. */
export async function sampleMachine(options: SampleMachineOptions = {}): Promise<MachineTelemetry> {
  const io = options.host ?? host;
  const start = performance.now(), sampledAtMs = io.now(), previous = options.previous;
  const mac = io.platform === 'darwin', linux = io.platform === 'linux';
  const supported = mac || linux;
  const command = (file: string, args: string[]) => io.command(file, args).catch(() => null);
  const read = (file: string) => io.read(file).catch(() => null);
  const [ps, df, status, vm, pressure, pressureLevel, swap, accelerators, meminfo, linuxGpu] = await Promise.all([
    supported ? command('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=']) : null,
    supported ? command('/bin/df', ['-lkP']) : null,
    read(options.statusPath ?? join(os.homedir(), '.ashlr-runs', 'queue', 'status.json')),
    mac ? command('/usr/bin/vm_stat', []) : null,
    mac ? command('/usr/bin/memory_pressure', ['-Q']) : null,
    mac ? command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : null,
    mac ? command('/usr/sbin/sysctl', ['vm.swapusage']) : null,
    mac ? command('/usr/bin/powermetrics', ['--samplers', 'gpu_power,ane_power', '-n', '1', '-i', '1']) : null,
    linux ? read('/proc/meminfo') : null,
    linux ? read('/sys/class/drm/card0/device/gpu_busy_percent') : null,
  ]);
  const queue = parseQueueStatus(status), jobs = sumJobTrees(queue.pids, parsePs(ps));
  const macMemory = parseVmStat(vm), linuxMemory = parseLinuxMemory(meminfo);
  const totalBytes = linux ? linuxMemory?.totalBytes ?? null : mac ? io.totalmem() : null;
  const freeBytes = linux ? linuxMemory?.freeBytes ?? null : mac ? macMemory?.freeBytes ?? io.freemem() : null;
  const usedBytes = totalBytes !== null && freeBytes !== null && freeBytes <= totalBytes ? totalBytes - freeBytes : null;
  const swapUsed = mac ? parseMacSwap(swap) : linuxMemory?.swapUsedBytes ?? null;
  // Persisted baselines survive one-shot CLI invocations, but stale/reset clocks do not imply zero growth.
  const elapsed = previous && previous.platform === io.platform ? sampledAtMs - previous.sampledAtMs : 0;
  const growth = swapUsed !== null && previous?.swap.usedBytes != null && elapsed > 0 && elapsed <= 300_000
    ? Math.max(0, swapUsed - previous.swap.usedBytes) * 1000 / elapsed : null;
  const cpuCounters = supported ? io.cpus() : [];
  const cores = cpuCounters.map((core, i) => {
    const totalMs = Object.values(core.times).reduce((sum, n) => sum + n, 0), idleMs = core.times.idle;
    const old = previous?.cpu.perCore[i], total = old ? totalMs - old.totalMs : 0, idle = old ? idleMs - old.idleMs : -1;
    const valid = elapsed > 0 && previous?.cpu.perCore.length === cpuCounters.length && total > 0 && idle >= 0 && idle <= total;
    return { totalMs, idleMs, usedPercent: valid ? (total - idle) / total * 100 : null };
  });
  const estimate = Number.isSafeInteger(options.estimatedJobRssBytes) && options.estimatedJobRssBytes! > 0
    ? options.estimatedJobRssBytes! : DEFAULT_RSS;
  const estimatedJobRssBytes = Math.max(estimate, ...jobs.map(job => job.rssBytes ?? 0));
  const level = mac ? parseMemoryPressure(`level: ${pressureLevel?.trim()}`) ?? parseMemoryPressure(pressure) : null;
  const freePercentValue = Number(pressure?.match(/System-wide memory free percentage:\s*(\d+)%/i)?.[1]);
  const freePercent = Number.isFinite(freePercentValue) && freePercentValue >= 0 && freePercentValue <= 100 ? freePercentValue : null;
  const acceleratorReading = parseAccelerators(accelerators);
  const gpu = linuxGpu?.trim() ? Number(linuxGpu.trim()) : NaN;
  if (linux && Number.isFinite(gpu) && gpu >= 0 && gpu <= 100) acceleratorReading.gpuPercent = gpu;
  return {
    schemaVersion: 1, sampledAtMs, platform: io.platform, durationMs: performance.now() - start,
    cpu: { perCore: cores, loadAverage: supported ? io.loadavg() : [] }, ram: { totalBytes, freeBytes, usedBytes },
    swap: { usedBytes: swapUsed, growthBytesPerSecond: growth },
    memoryPressure: { level, freePercent, pageouts: macMemory?.pageouts ?? null },
    disks: parseDisks(df), ...acceleratorReading, jobs,
    queueState: queue.paused === null ? 'unknown' : 'known', memguardPaused: queue.paused, estimatedJobRssBytes,
    headroom: level === 'critical' ? 0 : machineHeadroom(freeBytes, growth, queue.paused, estimatedJobRssBytes, jobs),
  };
}
