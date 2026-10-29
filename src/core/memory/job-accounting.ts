import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const exec = promisify(execFile);
const GB_HOUR = 1e9 * 3_600_000;
export interface ProcessMemory {
  pid: number;
  ppid: number;
  rssBytes: number;
  /** null means unavailable, never inferred from machine-wide swap. */
  swapBytes: number | null;
}
export interface JobMemory {
  schemaVersion: 1;
  sampleCount: number;
  observedMs: number;
  peakRssBytes: number;
  averageRssBytes: number | null;
  peakSwapBytes: number | null;
  averageSwapBytes: number | null;
  rssGbHours: number;
  swapGbHours: number | null;
}
export interface MemoryJobRecord {
  schemaVersion: 1;
  jobId: string;
  pool: string;
  startedAt: string;
  finishedAt: string;
  memory: JobMemory;
}

/** A snapshot includes only the root and descendants present in this process table. */
export function processTreeMemory(rootPid: number, rows: readonly ProcessMemory[]): ProcessMemory | null {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  if (!byPid.has(rootPid)) return null;
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  let rssBytes = 0;
  let swapBytes: number | null = 0;
  for (const pid of selected) {
    const row = byPid.get(pid)!;
    if (!Number.isFinite(row.rssBytes) || row.rssBytes < 0) return null;
    rssBytes += row.rssBytes;
    if (row.swapBytes === null || !Number.isFinite(row.swapBytes) || row.swapBytes < 0) swapBytes = null;
    else if (swapBytes !== null) swapBytes += row.swapBytes;
  }
  return { pid: rootPid, ppid: byPid.get(rootPid)!.ppid, rssBytes, swapBytes };
}

/** Time-weighted, zero-order hold integration between successful samples.
 * Failed samples break coverage. No extrapolation before the first or after the last sample.
 */
export class JobMemoryAccumulator {
  private previous: { at: number; memory: ProcessMemory } | undefined;
  private lastAt = -Infinity;
  private count = 0;
  private duration = 0;
  private rssIntegral = 0;
  private swapIntegral = 0;
  private peakRss = 0;
  private peakSwap = 0;
  private swapKnown = true;

  sample(at: number, memory: ProcessMemory | null): void {
    if (!Number.isFinite(at) || at <= this.lastAt) throw new Error('Samples must have increasing finite timestamps');
    this.lastAt = at;
    if (!memory) { this.previous = undefined; return; }
    if (!Number.isFinite(memory.rssBytes) || memory.rssBytes < 0 ||
        (memory.swapBytes !== null && (!Number.isFinite(memory.swapBytes) || memory.swapBytes < 0))) {
      throw new Error('Invalid memory sample');
    }
    if (this.previous) {
      const elapsed = at - this.previous.at;
      this.duration += elapsed;
      this.rssIntegral += elapsed * this.previous.memory.rssBytes;
      this.swapIntegral += elapsed * (this.previous.memory.swapBytes ?? 0);
    }
    this.count++;
    this.peakRss = Math.max(this.peakRss, memory.rssBytes);
    this.swapKnown &&= memory.swapBytes !== null;
    this.peakSwap = Math.max(this.peakSwap, memory.swapBytes ?? 0);
    this.previous = { at, memory: { ...memory } };
  }

  summary(): JobMemory {
    const swapKnown = this.swapKnown && this.count > 0;
    return {
      schemaVersion: 1, sampleCount: this.count, observedMs: this.duration,
      peakRssBytes: this.peakRss,
      averageRssBytes: this.duration > 0 ? this.rssIntegral / this.duration : null,
      peakSwapBytes: swapKnown ? this.peakSwap : null,
      averageSwapBytes: swapKnown && this.duration > 0 ? this.swapIntegral / this.duration : null,
      rssGbHours: this.rssIntegral / GB_HOUR,
      swapGbHours: swapKnown ? this.swapIntegral / GB_HOUR : null,
    };
  }
}

/** ps RSS is KiB on macOS and Linux. Linux exposes per-process VmSwap;
 * macOS ps does not, so its swap attribution remains explicitly unknown.
 * Commands and environments are deliberately never collected.
 */
export async function sampleProcessTree(rootPid: number): Promise<ProcessMemory | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Invalid root PID');
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  const rows: ProcessMemory[] = [];
  for (const line of stdout.trim().split('\n')) {
    const values = line.trim().split(/\s+/).map(Number);
    if (values.length !== 3 || values.some(n => !Number.isSafeInteger(n) || n < 0)) continue;
    rows.push({ pid: values[0]!, ppid: values[1]!, rssBytes: values[2]! * 1024, swapBytes: null });
  }
  // Read swap only for descendants, avoiding /proc work proportional to the host.
  const tree = processTreeMemory(rootPid, rows);
  if (!tree || process.platform !== 'linux') return tree;
  const selected = new Set([rootPid]);
  for (let size = -1; size !== selected.size;) {
    size = selected.size;
    for (const row of rows) if (selected.has(row.ppid)) selected.add(row.pid);
  }
  for (const row of rows) {
    if (!selected.has(row.pid)) continue;
    try {
      const status = await readFile(`/proc/${row.pid}/status`, 'utf8');
      const swap = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status);
      row.swapBytes = swap ? Number(swap[1]) * 1024 : null;
    } catch { /* Exited or inaccessible processes have unknown swap. */ }
  }
  return processTreeMemory(rootPid, rows);
}

/** Starts immediately, serializes probes, and drains the pending probe on stop. */
export function startJobMemorySampling(rootPid: number, options: {
  intervalMs?: number;
  sample?: (pid: number) => Promise<ProcessMemory | null>;
  now?: () => number;
} = {}): { stop: () => Promise<JobMemory> } {
  const interval = options.intervalMs ?? 1_000;
  if (!Number.isFinite(interval) || interval < 10) throw new Error('Invalid sample interval');
  const accumulator = new JobMemoryAccumulator();
  const sample = options.sample ?? sampleProcessTree;
  const now = options.now ?? (() => performance.now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = async (): Promise<void> => {
    let value: ProcessMemory | null;
    try { value = await sample(rootPid); } catch { value = null; }
    accumulator.sample(now(), value);
    if (!stopped) timer = setTimeout(() => { pending = probe(); }, interval);
  };
  let pending = probe();
  return { stop: async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    return accumulator.summary();
  } };
}

export function isMemoryJobRecord(value: unknown): value is MemoryJobRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as MemoryJobRecord;
  const m = r.memory;
  const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return r.schemaVersion === 1 && typeof r.jobId === 'string' && r.jobId.length > 0 &&
    typeof r.pool === 'string' && r.pool.length > 0 &&
    typeof r.startedAt === 'string' && typeof r.finishedAt === 'string' &&
    Number.isFinite(Date.parse(r.startedAt)) && Date.parse(r.finishedAt) >= Date.parse(r.startedAt) &&
    !!m && m.schemaVersion === 1 && Number.isSafeInteger(m.sampleCount) && m.sampleCount >= 0 &&
    [m.observedMs, m.peakRssBytes, m.rssGbHours].every(nonnegative) &&
    m.observedMs <= Date.parse(r.finishedAt) - Date.parse(r.startedAt) &&
    (m.sampleCount > 0 || (m.observedMs === 0 && m.peakRssBytes === 0 && m.peakSwapBytes === null)) &&
    [m.averageRssBytes, m.peakSwapBytes, m.averageSwapBytes, m.swapGbHours].every(n => n === null || nonnegative(n)) &&
    (m.observedMs === 0 ? m.averageRssBytes === null && m.rssGbHours === 0 :
      m.sampleCount >= 2 && m.averageRssBytes !== null && m.averageRssBytes <= m.peakRssBytes &&
      Math.abs(m.rssGbHours - m.averageRssBytes * m.observedMs / GB_HOUR) <= 1e-9) &&
    (m.peakSwapBytes === null
      ? m.averageSwapBytes === null && m.swapGbHours === null
      : m.swapGbHours !== null && (m.observedMs === 0
        ? m.averageSwapBytes === null && m.swapGbHours === 0
        : m.averageSwapBytes !== null && m.averageSwapBytes <= m.peakSwapBytes &&
          Math.abs(m.swapGbHours - m.averageSwapBytes * m.observedMs / GB_HOUR) <= 1e-9));
}

export async function appendMemoryJobRecord(path: string, record: MemoryJobRecord): Promise<void> {
  if (!isMemoryJobRecord(record)) throw new Error('Invalid memory job record');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
