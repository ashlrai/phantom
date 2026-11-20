/**
 * `phm host memory`: is this Mac really short of memory, or is swap just growing while RAM is free?
 * Read-only: it reads vm_stat, sysctl, ps, the bridge's memstat.json and the dispatcher's swap samples
 * (queue/admission.json). It never stops, pauses or kills anything. Anything it cannot read is null and
 * named in `gaps`; unknown is never shown as zero.
 */
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { parseSwapUsage, parseVmStat } from '../run/host-headroom.js';
import { readFleetMemoryFiles } from './memory-files.js';
import { memoryView } from './memory-view.js';
import { baseName, parseHostPs, plainName, readHostPs } from './host-load.js';
import { defaultRunsDir, runRead } from './host-top.js';

export const HOST_MEMORY_SCHEMA = 'host.memory.v1';
/** Free memory under this percent is real pressure; the same line gates swap-growth cuts in contrib/mac/memguard/rules.ts. */
export const REAL_PRESSURE_FREE_PCT = 35;
/** Swap growing this fast (MB per minute, 2 GB over the dispatcher's 5-minute window) counts as growing. */
export const SWAP_GROWING_MB_PER_MIN = 400;
/** Swap readings older than this are not used for the growth rate. */
const SWAP_WINDOW_S = 10 * 60;
/** A rate needs at least this much time between readings. */
const MIN_SPAN_S = 60;
const LARGEST = 5;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export type HostMemoryVerdict = 'real-pressure' | 'false-alarm' | 'fine' | 'unknown';

export interface HostMemoryProcess { pid: number; name: string; memoryMb: number }

export interface HostMemoryReport {
  schema: typeof HOST_MEMORY_SCHEMA;
  asOf: string;
  verdict: HostMemoryVerdict;
  /** One plain sentence. */
  summary: string;
  freePercent: number | null;
  swapUsedGb: number | null;
  /** MB per minute over the last 10 minutes; null when there are not two readings a minute apart. Negative means falling. */
  swapGrowthMbPerMin: number | null;
  swapoutsPerMin: number | null;
  /** The 5 largest processes by resident memory, biggest first. Shared memory is counted per process. */
  topProcesses: HostMemoryProcess[];
  thresholds: { realPressureFreePercent: number; swapGrowingMbPerMin: number };
  gaps: string[];
}

/** Pure: real pressure is free memory under 35% or swapouts above 0; swap growth alone is a false alarm. */
export function memoryVerdict(m: { freePercent: number | null; swapoutsPerMin: number | null; swapGrowthMbPerMin: number | null }): HostMemoryVerdict {
  const { freePercent: free, swapoutsPerMin: outs, swapGrowthMbPerMin: growth } = m;
  if ((free !== null && free < REAL_PRESSURE_FREE_PCT) || (outs !== null && outs > 0)) return 'real-pressure';
  if (free === null) return 'unknown';
  const growing = growth !== null && growth >= SWAP_GROWING_MB_PER_MIN;
  if (outs === null) return growing || growth === null ? 'unknown' : 'fine';
  return growing ? 'false-alarm' : 'fine';
}

const SAYS: Record<HostMemoryVerdict, string> = {
  'real-pressure': 'Real pressure: free memory is low or memory is being swapped out right now.',
  'false-alarm': 'Swap is growing but memory is free (likely a false alarm): nothing is being swapped out.',
  fine: 'Fine: memory is free and swap is steady.',
  unknown: 'Unknown: not enough memory readings to tell.',
};

export interface HostMemoryInput {
  psText: string | null;
  vmStatText: string | null;
  swapText: string | null;
  totalBytes: number | null;
  /** Parsed memstat.json and queue/admission.json; null when unread. */
  memstat: unknown;
  admission: unknown;
  now: number;
}

/** [epoch seconds, swap GB] pairs the dispatcher keeps in queue/admission.json; junk rows are skipped. */
function swapSamples(admission: unknown): Array<[number, number]> {
  const raw = admission && typeof admission === 'object' ? (admission as Record<string, unknown>).swap_samples : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row): Array<[number, number]> =>
    Array.isArray(row) && row.length === 2 && row.every(v => typeof v === 'number' && Number.isFinite(v)) ? [[row[0] as number, row[1] as number]] : []);
}

/** Pure: canned text in, one typed report out. Never runs a command. */
export function buildHostMemory(input: HostMemoryInput): HostMemoryReport {
  const view = memoryView(input.memstat, null, input.now).sample;
  const fresh = view.stale === false;
  const liveFree = input.vmStatText && input.totalBytes ? parseVmStat(input.vmStatText, input.totalBytes) : null;
  const liveSwap = input.swapText ? parseSwapUsage(input.swapText) : null;
  const freePercent = liveFree !== null ? Math.round(liveFree) : fresh ? view.free_pct : null;
  const swapUsedGb = liveSwap !== null ? round1(liveSwap) : fresh ? view.swap_gb : null;
  const swapoutsPerMin = fresh ? view.swapouts_per_min : null;

  const nowS = input.now / 1000;
  const points = swapSamples(input.admission).filter(([at]) => at <= nowS && nowS - at <= SWAP_WINDOW_S);
  if (liveSwap !== null) points.push([nowS, liveSwap]);
  points.sort((a, b) => a[0] - b[0]);
  const first = points[0], last = points[points.length - 1];
  const span = first && last ? last[0] - first[0] : 0;
  const swapGrowthMbPerMin = first && last && span >= MIN_SPAN_S ? Math.round(((last[1] - first[1]) * 1024) / (span / 60)) : null;

  const rows = [...parseHostPs(input.psText).values()].sort((a, b) => b.rssKb - a.rssKb).slice(0, LARGEST);
  const topProcesses = rows.map(row => ({ pid: row.pid, name: plainName(baseName(row.comm)), memoryMb: Math.round(row.rssKb / 1024) }));

  const gaps: string[] = [];
  if (freePercent === null) gaps.push('Free memory is unknown: vm_stat could not be read and memstat.json is missing or stale.');
  if (swapUsedGb === null) gaps.push('Swap used is unknown.');
  if (swapGrowthMbPerMin === null) gaps.push('Swap growth is unknown: there are not two swap readings a minute apart in the last 10 minutes.');
  if (swapoutsPerMin === null) gaps.push('Swapouts per minute are unknown: memstat.json is missing or older than 5 minutes.');
  if (topProcesses.length === 0) gaps.push('The process list is unavailable, so the largest processes are unknown.');
  const verdict = memoryVerdict({ freePercent, swapoutsPerMin, swapGrowthMbPerMin });
  return {
    schema: HOST_MEMORY_SCHEMA, asOf: new Date(input.now).toISOString(), verdict, summary: SAYS[verdict],
    freePercent, swapUsedGb, swapGrowthMbPerMin, swapoutsPerMin, topProcesses,
    thresholds: { realPressureFreePercent: REAL_PRESSURE_FREE_PCT, swapGrowingMbPerMin: SWAP_GROWING_MB_PER_MIN }, gaps,
  };
}

export interface HostMemoryDeps {
  /** Text of `ps -axo pid,ppid,pcpu,rss,comm`, or null. Tests inject text. */
  ps?: () => Promise<string | null>;
  /** Runs one fixed read-only command and returns its text, or null. */
  run?: (file: string, args: string[]) => Promise<string | null>;
  /** Runs dir holding memstat.json and queue/admission.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  totalBytes?: number;
  now?: () => number;
  /** Reads queue/admission.json text; tests inject. */
  readAdmission?: (runsDir: string) => Promise<string | null>;
}

const quiet = async <T,>(read: () => Promise<T | null>): Promise<T | null> => { try { return await read(); } catch { return null; } };

/** The one impure entry: reads everything at once, then hands it to buildHostMemory. Never throws, never acts. */
export async function readHostMemory(deps: HostMemoryDeps = {}): Promise<HostMemoryReport> {
  const run = deps.run ?? runRead, runsDir = deps.runsDir ?? defaultRunsDir();
  const [psText, vmStatText, swapText, files, admissionText] = await Promise.all([
    quiet(deps.ps ?? readHostPs), quiet(() => run('/usr/bin/vm_stat', [])), quiet(() => run('/usr/sbin/sysctl', ['vm.swapusage'])),
    quiet(() => readFleetMemoryFiles(runsDir)),
    quiet(() => (deps.readAdmission ?? ((dir: string) => readFile(join(dir, 'queue', 'admission.json'), 'utf8')))(runsDir)),
  ]);
  let admission: unknown = null;
  try { admission = JSON.parse(admissionText ?? ''); } catch { /* No readable swap samples. */ }
  return buildHostMemory({ psText, vmStatText, swapText, totalBytes: deps.totalBytes ?? totalmem(), memstat: files?.memstat ?? null, admission, now: (deps.now ?? Date.now)() });
}

export function formatHostMemory(report: HostMemoryReport): string {
  const show = (value: number | null, unit: string): string => value === null ? 'unknown' : `${value}${unit}`;
  const lines = [
    report.summary,
    `Free memory: ${show(report.freePercent, '%')}`,
    `Swap used: ${show(report.swapUsedGb, ' GB')}`,
    `Swap growth: ${show(report.swapGrowthMbPerMin, ' MB per minute')}`,
    `Swapouts: ${show(report.swapoutsPerMin, ' per minute')}`,
  ];
  if (report.topProcesses.length) {
    lines.push('', 'Largest by memory:');
    for (const p of report.topProcesses) lines.push(`  ${p.name.slice(0, 30).padEnd(30)} ${`${p.memoryMb} MB`.padStart(9)}  pid ${p.pid}`);
  }
  return [...lines, ...report.gaps.map(gap => `Note: ${gap}`)].join('\n');
}
