/** Host admission is separate from the browser-safe subscription headroom model. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { parseLinuxMemory } from '../resources/telemetry-parsers.js';
import { readWindowsPowerShell, windowsPowerShellArgs, windowsPowerShellPath } from '../util/windows-powershell.js';

export interface HostHeadroom {
  /** Unallocated plus speculative pages, as a percentage of physical RAM. */
  freePercent: number;
  /** Used swap in binary gigabytes (GiB), not allocated swap capacity. */
  swapGb: number;
  /** Kernel dispatch pressure level: normal, warning, or critical. */
  pressureLevel: 1 | 2 | 4;
}

/** Parse a single vm_stat snapshot. Inactive and purgeable pages are not free. */
export function parseVmStat(text: string, totalBytes: number): number | null {
  const pageSize = Number(text.match(/\(page size of (\d+) bytes\)/)?.[1]);
  const count = (name: string): number => {
    const matches = [...text.matchAll(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0]![1]) : NaN;
  };
  const free = count('free');
  const speculative = count('speculative');
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || !Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
      !Number.isSafeInteger(free) || !Number.isSafeInteger(speculative)) return null;
  const bytes = (free + speculative) * pageSize;
  return Number.isSafeInteger(bytes) && bytes <= totalBytes ? bytes / totalBytes * 100 : null;
}

/** macOS reports swap in binary K/M/G/T units, normally M with two decimals. */
export function parseSwapUsage(text: string): number | null {
  const match = text.trim().match(/^vm\.swapusage:\s+total = ([\d.]+)([KMGT])\s+used = ([\d.]+)([KMGT])\s+free = ([\d.]+)([KMGT])(?:\s+\(encrypted\))?$/);
  if (!match) return null;
  const gb = (value: string, unit: string): number => /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1024 ** ('KMGT'.indexOf(unit) - 2) : NaN;
  const total = gb(match[1]!, match[2]!);
  const used = gb(match[3]!, match[4]!);
  const free = gb(match[5]!, match[6]!);
  return [total, used, free].every(Number.isFinite) && used <= total && free <= total ? used : null;
}

export type HostHeadroomDecision = {
  allowed: boolean;
  reading: HostHeadroom | null;
  reason: string | null;
};

/** Parse only known kernel dispatch levels; all other output is unknown. */
export function parsePressureLevel(text: string): 1 | 2 | 4 | null {
  const value = text.trim();
  return value === '1' ? 1 : value === '2' ? 2 : value === '4' ? 4 : null;
}

/** Only a known normal kernel pressure permits a launch. */
export function assessHostHeadroom(reading: HostHeadroom | null): HostHeadroomDecision {
  if (!reading || !Number.isFinite(reading.freePercent) || reading.freePercent < 0 || reading.freePercent > 100 ||
      !Number.isFinite(reading.swapGb) || reading.swapGb < 0 ||
      ![1, 2, 4].includes(reading.pressureLevel)) {
    return { allowed: false, reading: null, reason: 'Host memory telemetry unavailable; launch held.' };
  }
  const allowed = reading.pressureLevel === 1;
  const level = reading.pressureLevel === 2 ? 'warning' : 'critical';
  return { allowed, reading, reason: allowed ? null
    : `Host memory pressure ${level} (level ${reading.pressureLevel}); launch held until normal.` };
}

type CommandReader = (file: string, args: string[]) => string;
const readCommand: CommandReader = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** Fixed absolute executables, bounded output/time, and no command error text exposed. */
export function readMacMemoryDiagnostics(read: CommandReader = readCommand, totalBytes = totalmem()): Pick<HostHeadroom, 'freePercent' | 'swapGb'> | null {
  try {
    const freePercent = parseVmStat(read('/usr/bin/vm_stat', []), totalBytes);
    const swapGb = parseSwapUsage(read('/usr/sbin/sysctl', ['vm.swapusage']));
    return freePercent === null || swapGb === null ? null : { freePercent, swapGb };
  } catch { return null; }
}

export function readMacHostHeadroom(read: CommandReader = readCommand, totalBytes = totalmem()): HostHeadroom | null {
  try {
    const diagnostics = readMacMemoryDiagnostics(read, totalBytes);
    const pressureLevel = parsePressureLevel(read('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    return diagnostics === null || pressureLevel === null ? null : { ...diagnostics, pressureLevel };
  } catch { return null; }
}

/** PSI `some avg10` bands for Linux node-capacity admission: the percentage of
 * the last 10 s any task spent stalled on memory. These cutoffs are admission
 * policy, not a kernel level — below WARNING is background reclaim noise,
 * below CRITICAL is sustained partial stalls, at/above is thrashing. A missing
 * or unreadable PSI file is unknown, never normal. */
const LINUX_PSI_WARNING_AVG10 = 10;
const LINUX_PSI_CRITICAL_AVG10 = 30;

/** `/proc/pressure/memory` `some avg10` to a pressure level; null when absent or malformed. */
export function parseLinuxPressureLevel(text: string | null): 1 | 2 | 4 | null {
  const avg10 = Number(text?.match(/^some\s+avg10=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/m)?.[1]);
  if (!Number.isFinite(avg10) || avg10 < 0 || avg10 > 100) return null;
  return avg10 >= LINUX_PSI_CRITICAL_AVG10 ? 4 : avg10 >= LINUX_PSI_WARNING_AVG10 ? 2 : 1;
}

type LinuxFileReader = (path: string) => string | null;
/** Bounded read of a /proc or /etc virtual file; oversized or unreadable is unknown. */
const readLinuxFile: LinuxFileReader = path => {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= 256 * 1024 ? text : null;
  } catch { return null; }
};

/** Linux memory headroom, all measured on this host: MemAvailable share and
 * used swap from /proc/meminfo, pressure level from /proc/pressure/memory.
 * MemAvailable is the kernel's own estimate of allocatable memory, the honest
 * counterpart of macOS free-plus-speculative pages. Any missing or malformed
 * input is unknown, never normal. */
export function readLinuxHostHeadroom(read: LinuxFileReader = readLinuxFile): HostHeadroom | null {
  try {
    const mem = parseLinuxMemory(read('/proc/meminfo'));
    const pressureLevel = parseLinuxPressureLevel(read('/proc/pressure/memory'));
    if (mem === null || mem.totalBytes <= 0 || pressureLevel === null) return null;
    const freePercent = mem.freeBytes / mem.totalBytes * 100;
    if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) return null;
    return { freePercent, swapGb: mem.swapUsedBytes / 1024 ** 3, pressureLevel };
  } catch { return null; }
}

/** `% Committed Bytes In Use` bands for Windows node-capacity admission: the
 * share of the commit limit (physical RAM plus pagefile) already promised to
 * processes, the figure Windows itself reports under that counter name. These
 * cutoffs are admission policy, not a kernel level — below WARNING is ordinary
 * commit headroom, below CRITICAL is sustained commit pressure, at/above is
 * allocation-failure territory. A missing or unreadable reading is unknown,
 * never normal. */
const WINDOWS_COMMIT_WARNING_PERCENT = 80;
const WINDOWS_COMMIT_CRITICAL_PERCENT = 90;

/** One PowerShell CIM snapshot, every field already in bytes. */
export interface WindowsMemoryTelemetry {
  totalBytes: number;
  availableBytes: number;
  committedBytes: number;
  commitLimitBytes: number;
  pagefileUsedBytes: number;
}

const WINDOWS_TELEMETRY_LINE = /^(totalKB|availMB|committedBytes|commitLimitBytes|pagefileUsedMB)=(\d+)[ \t]*\r?$/;

/** Parse the fixed `key=value` lines the Windows headroom script prints. Every
 * non-blank line must be one of the five known keys with a non-negative safe
 * integer, each exactly once, and the totals must be consistent (RAM present,
 * available within total, commit charge within its limit); anything else
 * rejects the whole reading. */
export function parseWindowsMemoryTelemetry(text: string | null): WindowsMemoryTelemetry | null {
  if (typeof text !== 'string') return null;
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = WINDOWS_TELEMETRY_LINE.exec(line);
    if (!match) return null;
    const value = Number(match[2]);
    if (values.has(match[1]!) || !Number.isSafeInteger(value)) return null;
    values.set(match[1]!, value);
  }
  const totalKB = values.get('totalKB'), availMB = values.get('availMB');
  const committedBytes = values.get('committedBytes'), commitLimitBytes = values.get('commitLimitBytes');
  const pagefileUsedMB = values.get('pagefileUsedMB');
  if (totalKB === undefined || availMB === undefined || committedBytes === undefined ||
      commitLimitBytes === undefined || pagefileUsedMB === undefined) return null;
  const totalBytes = totalKB * 1024, availableBytes = availMB * 1024 ** 2;
  const pagefileUsedBytes = pagefileUsedMB * 1024 ** 2;
  if (![totalBytes, availableBytes, pagefileUsedBytes].every(Number.isSafeInteger) ||
      totalBytes <= 0 || availableBytes > totalBytes || commitLimitBytes <= 0 ||
      committedBytes > commitLimitBytes) return null;
  return { totalBytes, availableBytes, committedBytes, commitLimitBytes, pagefileUsedBytes };
}

/** One bounded CIM snapshot: allocatable MB, commit charge and limit in bytes,
 * and used pagefile MB summed over every pagefile instance. Fixed class and
 * property names are not localized; a missing class fails the script and a
 * missing property reads as zero, which the parser rejects. */
const WINDOWS_HEADROOM_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
  '$pm = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory',
  '$pf = @(Get-CimInstance -ClassName Win32_PageFileUsage)',
  '$usedMB = [long]0',
  'foreach ($p in $pf) { $usedMB += [long]$p.CurrentUsage }',
  '$totalKB = [long]$os.TotalVisibleMemorySize',
  '$availMB = [long]$pm.AvailableMBytes',
  '$committed = [long]$pm.CommittedBytes',
  '$commitLimit = [long]$pm.CommitLimit',
  '"totalKB=$totalKB"',
  '"availMB=$availMB"',
  '"committedBytes=$committed"',
  '"commitLimitBytes=$commitLimit"',
  '"pagefileUsedMB=$usedMB"',
].join('\n');

const WINDOWS_HEADROOM_ARGS = windowsPowerShellArgs(WINDOWS_HEADROOM_SCRIPT);

/** Windows memory headroom from one CIM snapshot: `Available MBytes` is the
 * allocatable share (standby included, the counterpart of MemAvailable), used
 * pagefile is used swap, and the committed-bytes bands supply the pressure
 * level. Any missing or inconsistent telemetry holds as unmeasured. */
export function readWindowsHostHeadroom(
  read: CommandReader = readWindowsPowerShell,
  systemRoot: string | undefined = process.env.SystemRoot,
): HostHeadroom | null {
  try {
    const executable = windowsPowerShellPath(systemRoot);
    if (!executable) return null;
    const telemetry = parseWindowsMemoryTelemetry(read(executable, WINDOWS_HEADROOM_ARGS));
    if (!telemetry) return null;
    const committedPercent = telemetry.committedBytes / telemetry.commitLimitBytes * 100;
    const pressureLevel = committedPercent >= WINDOWS_COMMIT_CRITICAL_PERCENT ? 4
      : committedPercent >= WINDOWS_COMMIT_WARNING_PERCENT ? 2 : 1;
    const freePercent = telemetry.availableBytes / telemetry.totalBytes * 100;
    if (!Number.isFinite(freePercent) || freePercent < 0 || freePercent > 100) return null;
    return { freePercent, swapGb: telemetry.pagefileUsedBytes / 1024 ** 3, pressureLevel };
  } catch { return null; }
}

/** The platform's memory-headroom reader: macOS kernel telemetry, Linux /proc,
 * Windows CIM; other platforms have no reader and return null, which callers
 * hold as unmeasured rather than wrongly ready. */
export function readPlatformHostHeadroom(): HostHeadroom | null {
  return process.platform === 'darwin' ? readMacHostHeadroom()
    : process.platform === 'linux' ? readLinuxHostHeadroom()
    : process.platform === 'win32' ? readWindowsHostHeadroom() : null;
}

/** Every attempt samples afresh; the kernel provides pressure recovery smoothing. */
export function createHostHeadroomGate(read: () => HostHeadroom | null = readMacHostHeadroom): () => HostHeadroomDecision {
  return () => {
    let reading: HostHeadroom | null;
    try { reading = read(); } catch { reading = null; }
    return assessHostHeadroom(reading);
  };
}

const macGate = createHostHeadroomGate();
/** This collector is macOS-specific; other hosts retain their existing admission. */
export function checkHostHeadroom(): HostHeadroomDecision {
  return process.platform === 'darwin' ? macGate() : { allowed: true, reading: null, reason: null };
}
