/** Opt-in, local-only machine telemetry. No shell, sudo, network or process arguments. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import type { CpuInfo } from 'node:os';
import { readVerifiedFleetRoots, observedPsStartIdentity, type VerifiedFleetRootsObservation } from './machine-verified-roots.js';
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
  /** Legacy 25% calculation, advisory only. */
  advisoryHeadroom: number;
  headroom: null;
  rootsState: 'known' | 'unknown';
  jobCpuBasis: 'os-average-one-core-100-percent';
  sharedRssMayBeCountedMultipleTimes: true;
  perProcessSwapBytes: null;
  /** Same numeric process census, not physical host RAM: shared RSS can repeat. */
  processAttribution: { state: 'known' | 'unknown'; observedProcesses: number | null; attributedProcesses: number | null;
    unattributedProcesses: number | null; totalCpuPercentOneCore: number | null; unattributedCpuPercentOneCore: number | null;
    totalProcessRssBytes: number | null; unattributedProcessRssBytes: number | null };
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
  readRoots?: () => Promise<VerifiedFleetRootsObservation>;
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

/** Historical 25% advisory calculation only; never launch admission. Unknown inputs yield zero. */
export function machineHeadroom(freeBytes: number | null, growth: number | null, paused: boolean | null,
  rssPerSlot: number, jobs: JobReading[]): number {
  if (paused !== false || growth !== 0 || freeBytes === null || !Number.isFinite(freeBytes) || freeBytes < 0 ||
      !Number.isSafeInteger(rssPerSlot) || rssPerSlot <= 0 || jobs.some(job => job.rssBytes === null)) return 0;
  return Math.max(0, Math.floor(freeBytes * 0.75 / rssPerSlot));
}

/** A single no-wait sample; deltas use a prior observation rather than sleeping. */
export async function sampleMachine(options: SampleMachineOptions = {}): Promise<MachineTelemetry> {
  const io = options.host ?? host;
  const start = performance.now(), previous = options.previous;
  const mac = io.platform === 'darwin', linux = io.platform === 'linux';
  const supported = mac || linux;
  const rootReader = options.readRoots ?? (() => readVerifiedFleetRoots({ runsDir: join(os.homedir(), '.ashlr-runs'), worktreeRoot: join(os.homedir(), 'Projects', 'ashlrai', 'wt') }));
  const command = (file: string, args: string[]) => io.command(file, args).catch(() => null);
  const read = (file: string) => io.read(file).catch(() => null);
  const [ps, df, status, vm, pressure, pressureLevel, swap, accelerators, meminfo, linuxGpu, rootObservation] = await Promise.all([
    supported ? command('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,lstart=']) : null,
    supported ? command('/bin/df', ['-lkP']) : null,
    read(options.statusPath ?? join(os.homedir(), '.ashlr-runs', 'queue', 'status.json')),
    mac ? command('/usr/bin/vm_stat', []) : null,
    mac ? command('/usr/bin/memory_pressure', ['-Q']) : null,
    mac ? command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : null,
    mac ? command('/usr/sbin/sysctl', ['vm.swapusage']) : null,
    mac ? command('/usr/bin/powermetrics', ['--samplers', 'gpu_power,ane_power', '-n', '1', '-i', '1']) : null,
    linux ? read('/proc/meminfo') : null,
    linux ? read('/sys/class/drm/card0/device/gpu_busy_percent') : null,
    supported ? Promise.resolve().then(rootReader).catch(() => null) : null,
  ]);
  const queue = parseQueueStatus(status);
  // Timestamp completion, so a legitimate root observation made during probes
  // is not rejected as being ahead of this sample's earlier start time.
  const sampledAtMs = io.now();
  const startRefs = new Map<number, string>();
  let processRows: ReturnType<typeof parsePs> = null;
  if (ps?.trim()) {
    const numeric: string[] = []; let valid = true;
    for (const line of ps.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      const start = match ? observedPsStartIdentity(Number(match[1]), match[5]!, io.platform as NodeJS.Platform) : undefined;
      if (!match || !start || startRefs.has(Number(match[1]))) { valid = false; break; }
      numeric.push(match.slice(1, 5).join(' ')); startRefs.set(Number(match[1]), start.ref);
    }
    if (valid) processRows = parsePs(numeric.join('\n'));
  }
  const rootsKnown = !!rootObservation && rootObservation.schemaVersion === 1 && rootObservation.scope === 'verified-fleet-process-roots' &&
    rootObservation.authority === 'observation-only' && rootObservation.state === 'known' && Array.isArray(rootObservation.roots) &&
    rootObservation.roots.length <= 128 && new Set(rootObservation.roots.map(r => r?.pid)).size === rootObservation.roots.length &&
    new Set(rootObservation.roots.map(r => r?.jobId)).size === rootObservation.roots.length && rootObservation.roots.every(r => r &&
      Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.jobId === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(r.jobId) &&
      typeof r.startRef === 'string' && /^[a-f0-9]{64}$/.test(r.startRef) && typeof r.bootRef === 'string' && /^[a-f0-9]{64}$/.test(r.bootRef) &&
      typeof r.ownerBindingDigest === 'string' && /^[a-f0-9]{64}$/.test(r.ownerBindingDigest) &&
      r.startRefSource === 'ps-lstart' && startRefs.get(r.pid) === r.startRef) &&
    typeof rootObservation.observedAt === 'string' && Number.isFinite(Date.parse(rootObservation.observedAt)) &&
    Date.parse(rootObservation.observedAt) <= sampledAtMs && sampledAtMs - Date.parse(rootObservation.observedAt) <= 30000 && processRows !== null;
  const jobs = rootsKnown ? sumJobTrees(rootObservation!.roots.map(r => r.pid), processRows) : [];
  const covered = rootsKnown && jobs.every(j => j.cpuPercent !== null && j.rssBytes !== null);
  const totalCpu = processRows?.reduce((n, r) => n + r.cpuPercent, 0) ?? null;
  const totalRss = processRows?.reduce((n, r) => n + r.rssBytes, 0) ?? null;
  const attributedCount = covered ? jobs.reduce((n, j) => n + j.processes, 0) : null;
  const processAttribution: MachineTelemetry['processAttribution'] = {
    state: covered ? 'known' : 'unknown', observedProcesses: processRows?.length ?? null, attributedProcesses: attributedCount,
    unattributedProcesses: attributedCount === null ? null : processRows!.length - attributedCount,
    totalCpuPercentOneCore: totalCpu !== null && Number.isFinite(totalCpu) ? totalCpu : null,
    unattributedCpuPercentOneCore: covered && totalCpu !== null ? Math.max(0, totalCpu - jobs.reduce((n, j) => n + j.cpuPercent!, 0)) : null,
    totalProcessRssBytes: totalRss !== null && Number.isSafeInteger(totalRss) ? totalRss : null,
    unattributedProcessRssBytes: covered && totalRss !== null && Number.isSafeInteger(totalRss) ? totalRss - jobs.reduce((n, j) => n + j.rssBytes!, 0) : null,
  };
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
    rootsState: rootsKnown ? 'known' : 'unknown', jobCpuBasis: 'os-average-one-core-100-percent',
    sharedRssMayBeCountedMultipleTimes: true, perProcessSwapBytes: null, headroom: null, processAttribution,
    advisoryHeadroom: !rootsKnown || !processRows || level === 'critical' ? 0 : machineHeadroom(freeBytes, growth, queue.paused, estimatedJobRssBytes, jobs),
  };
}
