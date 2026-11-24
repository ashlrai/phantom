/** Read-only OS observations. Pressure kinds retain their native meaning. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import { windowsPowerShellPath } from '../daemon/windows-task-scripts.js';
import { parseMacSwap, parseMemoryPressure } from './telemetry-parsers.js';

export interface OsObservation<T> {
  value: T | null;
  source: string;
  reason: 'unavailable' | 'unsupported' | 'invalid' | 'timeout' | null;
}
export type OsMemoryPressure =
  | { kind: 'kernel-level'; level: 'normal' | 'warning' | 'critical' }
  | { kind: 'psi'; someAvg10Percent: number; fullAvg10Percent: number }
  | { kind: 'commit'; usedPercent: number };
export type OsThermal = { kind: 'cpu-speed-limit'; percent: number } | { kind: 'max-zone-celsius'; celsius: number };
export interface OsSensorSnapshot {
  schema: 'os.sensors.v1';
  platform: string;
  sampledAtMs: number;
  memoryPressure: OsObservation<OsMemoryPressure>;
  swapUsedBytes: OsObservation<number>;
  compressedBytes: OsObservation<number>;
  loadPerCore: OsObservation<number>;
  thermal: OsObservation<OsThermal>;
}
/** A TelemetryHost can be passed directly. Missing enumeration stays unknown. */
export interface OsSensorHost {
  platform: string;
  now: () => number;
  cpus: () => readonly unknown[];
  loadavg: () => number[];
  read: (file: string, signal?: AbortSignal) => Promise<string | null>;
  command: (file: string, args: string[], signal?: AbortSignal) => Promise<string | null>;
  list?: (directory: string, signal?: AbortSignal) => Promise<string[] | null>;
}
const LIMIT = 64 * 1024;
const UNKNOWN = 'unsupported' as const;
type Probe<T> = { value: T | null; reason: OsObservation<T>['reason'] };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bytes = (value: unknown): value is number => numeric(value) && Number.isSafeInteger(value);
const percent = (value: unknown): value is number => numeric(value) && value <= 100;
const observation = <T>(value: T | null, source: string, reason: OsObservation<T>['reason'] = 'invalid'): OsObservation<T> =>
  ({ value, source, reason: value === null ? reason : null });
function parsed<T>(probe: Probe<string>, source: string, parse: (text: string) => T | null): OsObservation<T> {
  return observation(probe.value === null ? null : parse(probe.value), source, probe.reason ?? 'invalid');
}
function field(text: string, expression: RegExp): number | null {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0]![1]);
  return bytes(value) ? value : null;
}

/** Fixed, numeric-only CIM projection. No process list, names, handles or credentials. */
export const WINDOWS_OS_SENSOR_SCRIPT = `
$ErrorActionPreference = 'Stop'
$result = @{ commitBytes=$null; commitLimitBytes=$null; pagefileMiB=$null; temperaturesKelvin=$null }
try {
  $memory = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Memory -Property CommittedBytes,CommitLimit
  $result.commitBytes = $memory.CommittedBytes
  $result.commitLimitBytes = $memory.CommitLimit
} catch {}
try {
  $pages = @(Get-CimInstance -ClassName Win32_PageFileUsage -Property CurrentUsage)
  $result.pagefileMiB = @($pages | ForEach-Object { $_.CurrentUsage })
} catch {}
try {
  $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -Property Temperature)
  $result.temperaturesKelvin = @($zones | ForEach-Object { $_.Temperature })
} catch {}
$result | ConvertTo-Json -Compress -Depth 3
`;

export const defaultOsSensorHost: OsSensorHost = {
  platform: process.platform, now: Date.now, cpus: os.cpus, loadavg: os.loadavg,
  read: async (file) => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMIT) return null;
      const buffer = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead > LIMIT ? null : buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  },
  list: async directory => readdir(directory),
  command: (file, args, signal) => new Promise(resolve => {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const env = process.platform === 'win32'
      ? { SystemRoot: systemRoot, WINDIR: systemRoot }
      : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };
    const child = execFile(file, args, { signal, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: LIMIT,
      windowsHide: true, env }, (error, stdout) => resolve(error ? null : stdout));
    child.stdin?.end();
  }),
};

function psi(text: string): OsMemoryPressure | null {
  const values = ['some', 'full'].map(kind => {
    const matches = [...text.matchAll(new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?) avg60=\\d+(?:\\.\\d+)? avg300=\\d+(?:\\.\\d+)? total=\\d+\\s*$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0]![1]) : NaN;
  });
  return values.every(percent) && values[1]! <= values[0]!
    ? { kind: 'psi', someAvg10Percent: values[0]!, fullAvg10Percent: values[1]! } : null;
}

/** One bounded sample, without privilege prompts, sleeps, policy decisions or persistence. */
export async function readOsSensors(options: { host?: OsSensorHost; timeoutMs?: number } = {}): Promise<OsSensorSnapshot> {
  const host = options.host ?? defaultOsSensorHost;
  const budget = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(5_000, options.timeoutMs!)) : 2_000;
  const deadline = performance.now() + budget;
  async function probe<T>(read: (signal: AbortSignal) => Promise<T | null>): Promise<Probe<T>> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { value: null, reason: 'timeout' };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<Probe<T>>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve({ value: null, reason: 'timeout' }); }, remaining);
    });
    try {
      return await Promise.race([timeout, Promise.resolve().then(() => read(abort.signal))
        .then(value => ({ value, reason: value === null ? 'unavailable' as const : null }))
        .catch(() => ({ value: null, reason: 'unavailable' as const }))]);
    } finally { clearTimeout(timer!); }
  }
  const read = (file: string) => probe(signal => host.read(file, signal));
  const command = (file: string, args: string[]) => probe(signal => host.command(file, args, signal));
  const result: OsSensorSnapshot = {
    schema: 'os.sensors.v1', platform: host.platform, sampledAtMs: host.now(),
    memoryPressure: observation<OsMemoryPressure>(null, host.platform, UNKNOWN), swapUsedBytes: observation<number>(null, host.platform, UNKNOWN),
    compressedBytes: observation<number>(null, host.platform, UNKNOWN), loadPerCore: observation<number>(null, 'os.loadavg/logical-cpus', UNKNOWN),
    thermal: observation<OsThermal>(null, host.platform, UNKNOWN),
  };
  if (host.platform === 'darwin' || host.platform === 'linux') {
    try {
      const load = host.loadavg()[0], cores = host.cpus().length;
      result.loadPerCore = observation(numeric(load) && cores > 0 ? load / cores : null, 'os.loadavg/logical-cpus');
    } catch { result.loadPerCore.reason = 'unavailable'; }
  }
  if (host.platform === 'darwin') {
    const [pressure, swap, vm, thermal] = await Promise.all([
      command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      command('/usr/sbin/sysctl', ['vm.swapusage']), command('/usr/bin/vm_stat', []), command('/usr/bin/pmset', ['-g', 'therm']),
    ]);
    result.memoryPressure = parsed(pressure, 'sysctl:kern.memorystatus_vm_pressure_level', text => {
      const level = /^[124]$/.test(text.trim()) ? parseMemoryPressure(`level: ${text.trim()}`) : null;
      return level ? { kind: 'kernel-level', level } : null;
    });
    result.swapUsedBytes = parsed(swap, 'sysctl:vm.swapusage', text => {
      // sysctl rounds human-readable units. Normalize their conversion to
      // whole bytes, rejecting ambiguous fields and values beyond safe range.
      if ([...text.matchAll(/\bused\s*=/g)].length !== 1) return null;
      const value = parseMacSwap(text);
      return numeric(value) && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : null;
    });
    result.compressedBytes = parsed(vm, 'vm_stat:Pages occupied by compressor', text => {
      const pageSize = field(text, /page size of (\d+) bytes/g);
      const pages = field(text, /^Pages occupied by compressor:\s+(\d+)\.\s*$/gm);
      return pageSize !== null && pageSize > 0 && pages !== null && bytes(pages * pageSize) ? pages * pageSize : null;
    });
    result.thermal = parsed(thermal, 'pmset:CPU_Speed_Limit', text => {
      const speed = field(text, /^\s*CPU_Speed_Limit\s*=\s*(\d+)\s*$/gm);
      return percent(speed) ? { kind: 'cpu-speed-limit', percent: speed } : null;
    });
  } else if (host.platform === 'linux') {
    const [memory, pressure, thermalDirs, blockDirs] = await Promise.all([
      read('/proc/meminfo'), read('/proc/pressure/memory'),
      probe(signal => host.list?.('/sys/class/thermal', signal) ?? Promise.resolve(null)),
      probe(signal => host.list?.('/sys/block', signal) ?? Promise.resolve(null)),
    ]);
    result.memoryPressure = parsed(pressure, 'proc:pressure/memory', psi);
    result.swapUsedBytes = parsed(memory, 'proc:meminfo:SwapTotal-SwapFree', text => {
      // Each counter must be unambiguous. Other memory fields are independent
      // observations and cannot establish or invalidate this swap reading.
      const total = field(text, /^SwapTotal:\s+(\d+) kB\s*$/gm);
      const free = field(text, /^SwapFree:\s+(\d+) kB\s*$/gm);
      return total !== null && free !== null && free <= total && bytes(total * 1024) && bytes(free * 1024)
        ? (total - free) * 1024 : null;
    });
    const thermalNames = thermalDirs.value?.filter(name => /^thermal_zone\d+$/.test(name));
    if (thermalNames && thermalNames.length > 0 && thermalNames.length <= 32) {
      const values = await Promise.all(thermalNames.map(name => read(`/sys/class/thermal/${name}/temp`)));
      const temperatures = values.map(item => item.value?.trim()).map(value => value && /^-?\d+$/.test(value) ? Number(value) / 1000 : NaN);
      const valid = temperatures.every(value => Number.isFinite(value) && value >= -100 && value <= 250);
      result.thermal = observation(valid ? { kind: 'max-zone-celsius', celsius: Math.max(...temperatures) } : null,
        'sysfs:thermal_zone*/temp', values.find(value => value.reason)?.reason ?? 'invalid');
    } else result.thermal = observation<OsThermal>(null, 'sysfs:thermal_zone*/temp', thermalDirs.reason ?? 'unavailable');
    const zramNames = blockDirs.value?.filter(name => /^zram\d+$/.test(name));
    if (zramNames && zramNames.length <= 32) {
      const zram = await Promise.all(zramNames.map(name => read(`/sys/block/${name}/mm_stat`)));
      const resident = zram.map(value => {
        const fields = value.value?.trim().split(/\s+/);
        return fields && fields.length >= 3 && /^\d+$/.test(fields[2]!) ? Number(fields[2]) : null;
      });
      const zswap = memory.value === null ? null : field(memory.value, /^Zswap:\s+(\d+) kB\s*$/gm);
      // Missing Zswap is unknown even when zram is known: do not report a partial total.
      const total = zswap !== null && resident.every(bytes) ? zswap * 1024 + resident.reduce((sum, value) => sum + value, 0) : null;
      result.compressedBytes = observation(bytes(total) ? total : null, 'proc:Zswap+sysfs:zram:mem_used_total',
        memory.reason ?? zram.find(value => value.reason)?.reason ?? 'unavailable');
    } else result.compressedBytes = observation<number>(null, 'proc:Zswap+sysfs:zram:mem_used_total', blockDirs.reason ?? 'unavailable');
  } else if (host.platform === 'win32') {
    let windows: Probe<string>;
    try { windows = await command(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_OS_SENSOR_SCRIPT]); }
    catch { windows = { value: null, reason: 'unavailable' }; }
    let data: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(windows.value ?? 'null');
      if (value && typeof value === 'object' && !Array.isArray(value)) data = value as Record<string, unknown>;
    } catch { /* Invalid output remains unknown; raw output is never exposed. */ }
    const committed = data['commitBytes'], limit = data['commitLimitBytes'];
    result.memoryPressure = observation(bytes(committed) && bytes(limit) && limit > 0 && committed <= limit
      ? { kind: 'commit', usedPercent: committed / limit * 100 } : null, 'CIM:CommittedBytes/CommitLimit', windows.reason ?? 'invalid');
    const pages = data['pagefileMiB'];
    const pageBytes = Array.isArray(pages) && pages.length <= 128 && pages.every(bytes) ? pages.reduce((sum, value: number) => sum + value * 1024 ** 2, 0) : null;
    result.swapUsedBytes = observation(bytes(pageBytes) ? pageBytes : null, 'CIM:Win32_PageFileUsage.CurrentUsage', windows.reason ?? 'invalid');
    const temperatures = data['temperaturesKelvin'];
    const valid = Array.isArray(temperatures) && temperatures.length > 0 && temperatures.length <= 128 && temperatures.every(value => numeric(value) && value >= 173.15 && value <= 523.15);
    result.thermal = observation(valid ? { kind: 'max-zone-celsius', celsius: Math.max(...temperatures) - 273.15 } : null,
      'CIM:ThermalZoneInformation.Temperature', windows.reason ?? 'unavailable');
  }
  result.sampledAtMs = host.now();
  return result;
}
