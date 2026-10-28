/** Host admission is separate from the browser-safe subscription headroom model. */
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';

export interface HostHeadroom {
  /** Unallocated plus speculative pages, as a percentage of physical RAM. */
  freePercent: number;
  /** Used swap in binary gigabytes (GiB), not allocated swap capacity. */
  swapGb: number;
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

export const HOST_SWAP_WINDOW_MS = 10 * 60 * 1000;
const SWAP_GROWTH_LIMIT_GB = 2;

/** Absolute swap and free-page counts are diagnostics, not pressure signals. */
export function assessHostHeadroom(reading: HostHeadroom | null, swapGrowthGb = 0): HostHeadroomDecision {
  if (!reading || !Number.isFinite(reading.freePercent) || reading.freePercent < 0 || reading.freePercent > 100 ||
      !Number.isFinite(reading.swapGb) || reading.swapGb < 0 || !Number.isFinite(swapGrowthGb) || swapGrowthGb < 0) {
    return { allowed: false, reading: null, reason: 'Host memory telemetry unavailable; launch held.' };
  }
  const allowed = swapGrowthGb <= SWAP_GROWTH_LIMIT_GB;
  return { allowed, reading, reason: allowed ? null
    : `Host memory pressure: swap grew ${swapGrowthGb.toFixed(2)} GiB within 10 minutes; `
      + 'launch held until observed growth is at most 2 GiB.' };
}

type CommandReader = (file: string, args: string[]) => string;
const readCommand: CommandReader = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** Fixed absolute executables, bounded output/time, and no command error text exposed. */
export function readMacHostHeadroom(read: CommandReader = readCommand, totalBytes = totalmem()): HostHeadroom | null {
  try {
    const freePercent = parseVmStat(read('/usr/bin/vm_stat', []), totalBytes);
    const swapGb = parseSwapUsage(read('/usr/sbin/sysctl', ['vm.swapusage']));
    return freePercent === null || swapGb === null ? null : { freePercent, swapGb };
  } catch { return null; }
}

/** Per-process window, sampled on launch attempts with a monotonic clock. */
export function createHostHeadroomGate(
  read: () => HostHeadroom | null = readMacHostHeadroom,
  now: () => number = () => performance.now(),
): () => HostHeadroomDecision {
  let samples: { at: number; swapGb: number }[] = [];
  let lastAt = -Infinity;
  return () => {
    let reading: HostHeadroom | null;
    try { reading = read(); } catch { reading = null; }
    const validity = assessHostHeadroom(reading);
    if (!validity.allowed || !reading) return validity;
    const at = now();
    if (!Number.isFinite(at) || at < 0) return assessHostHeadroom(null);
    if (at < lastAt) samples = [];
    lastAt = at;
    samples = samples.filter(sample => at - sample.at <= HOST_SWAP_WINDOW_MS);
    // Keep the minimum and its actual timestamp per second, at most 601
    // observations. Partial buckets can lose less than one second of history;
    // no sample older than the window can cause a hold.
    const last = samples.at(-1);
    if (last && Math.floor(last.at / 1000) === Math.floor(at / 1000)) {
      if (reading.swapGb <= last.swapGb) { last.at = at; last.swapGb = reading.swapGb; }
    } else {
      samples.push({ at, swapGb: reading.swapGb });
    }
    const minimum = Math.min(...samples.map(sample => sample.swapGb));
    return assessHostHeadroom(reading, Math.max(0, reading.swapGb - minimum));
  };
}

let macGate = createHostHeadroomGate();
/** Exact opt-in, checked per attempt. Disabling also discards prior observations. */
export function checkHostHeadroom(): HostHeadroomDecision {
  if (process.platform !== 'darwin' || process.env['ASHLR_HOST_MEMORY_HOLD'] !== '1') {
    macGate = createHostHeadroomGate();
    return { allowed: true, reading: null, reason: null };
  }
  return macGate();
}
