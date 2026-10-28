/** Numeric-only host observations. Raw command lines and queue text never leave these parsers. */
export type MemoryPressure = 'normal' | 'warning' | 'critical' | null;
export interface ProcessReading { pid: number; ppid: number; cpuPercent: number; rssBytes: number }
export interface JobReading { pid: number; cpuPercent: number | null; rssBytes: number | null; processes: number }
export interface QueueReading { pids: number[]; paused: boolean | null }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function parseQueueStatus(text: string | null): QueueReading {
  try {
    const value: unknown = JSON.parse(text ?? 'null');
    if (!record(value)) return { pids: [], paused: null };
    const guard = value['memguard'];
    const state = record(guard) ? guard['state'] : guard;
    const paused = state === 'pause' || state === 'paused' || record(guard) && guard['paused'] === true
      ? true : state === 'normal' || state === 'run' || state === 'running' || state === 'resume' ||
        record(guard) && guard['paused'] === false ? false : null;
    const rows = value['running'] ?? value['jobs'];
    if (!Array.isArray(rows) || rows.length > 4096) return { pids: [], paused: null };
    const pids: number[] = [];
    for (const row of rows) {
      if (!record(row)) return { pids: [], paused: null };
      if (row['status'] !== undefined && row['status'] !== 'running') continue;
      if (!pid(row['pid'])) return { pids: [], paused: null };
      pids.push(row['pid']);
    }
    return { pids: [...new Set(pids)], paused };
  } catch { return { pids: [], paused: null }; }
}

export function parsePs(text: string | null): ProcessReading[] | null {
  if (!text?.trim()) return null;
  const result: ProcessReading[] = [];
  const seen = new Set<number>();
  for (const line of text.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) return null;
    const [id, parent, cpu, rss] = parts.map(Number) as [number, number, number, number];
    if (!pid(id) || !Number.isSafeInteger(parent) || parent < 0 || !Number.isFinite(cpu) || cpu < 0 ||
        !Number.isSafeInteger(rss) || rss < 0 || !Number.isSafeInteger(rss * 1024) || seen.has(id)) return null;
    seen.add(id); result.push({ pid: id, ppid: parent, cpuPercent: cpu, rssBytes: rss * 1024 });
  }
  return result;
}

export function sumJobTrees(pids: number[], processes: ProcessReading[] | null): JobReading[] {
  const byPid = new Map(processes?.map(row => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of processes ?? []) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid); else children.set(row.ppid, [row.pid]);
  }
  return pids.map(root => {
    if (!byPid.has(root)) return { pid: root, cpuPercent: null, rssBytes: null, processes: 0 };
    const seen = new Set<number>(), todo = [root];
    let cpuPercent = 0, rssBytes = 0;
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = byPid.get(id)!;
      cpuPercent += row.cpuPercent; rssBytes += row.rssBytes;
      todo.push(...(children.get(id) ?? []));
    }
    return { pid: root, cpuPercent, rssBytes, processes: seen.size };
  });
}

export function parseVmStat(text: string | null): { freeBytes: number; pageouts: number | null } | null {
  const pageSize = Number(text?.match(/page size of (\d+) bytes/)?.[1]);
  const free = Number(text?.match(/^Pages free:\s+(\d+)\./m)?.[1]);
  const speculative = Number(text?.match(/^Pages speculative:\s+(\d+)\./m)?.[1] ?? 0);
  const pageouts = Number(text?.match(/^Pageouts:\s+(\d+)\./m)?.[1]);
  if (![pageSize, free, speculative].every(Number.isSafeInteger) || pageSize <= 0 || free < 0 || speculative < 0) return null;
  return { freeBytes: (free + speculative) * pageSize, pageouts: Number.isSafeInteger(pageouts) && pageouts >= 0 ? pageouts : null };
}

export function parseMemoryPressure(text: string | null): MemoryPressure {
  const level = text?.match(/(?:pressure(?: level)?|level)\s*[:=]\s*(normal|warning|critical|[124])\b/i)?.[1]?.toLowerCase();
  if (level === '1' || level === 'normal') return 'normal';
  if (level === '2' || level === 'warning') return 'warning';
  if (level === '4' || level === 'critical') return 'critical';
  return null;
}

export function parseMacSwap(text: string | null): number | null {
  const match = text?.match(/used\s*=\s*([\d.]+)([KMGT])\b/i);
  if (!match) return null;
  const value = Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2]!.toUpperCase()) + 1);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseLinuxMemory(text: string | null): { totalBytes: number; freeBytes: number; swapUsedBytes: number } | null {
  const read = (key: string) => Number(text?.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm'))?.[1]) * 1024;
  const totalBytes = read('MemTotal'), freeBytes = read('MemAvailable'), swapTotal = read('SwapTotal'), swapFree = read('SwapFree');
  if (![totalBytes, freeBytes, swapTotal, swapFree].every(value => Number.isSafeInteger(value) && value >= 0) ||
      totalBytes <= 0 || freeBytes > totalBytes || swapFree > swapTotal) return null;
  return { totalBytes, freeBytes, swapUsedBytes: swapTotal - swapFree };
}

export function parseDisks(text: string | null): Array<{ volume: string; freeBytes: number }> | null {
  if (!text?.startsWith('Filesystem')) return null;
  const volumes = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const match = line.match(/^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/);
    if (!match || !Number.isSafeInteger(Number(match[1]) * 1024)) return null;
    volumes.push({ volume: match[2]!, freeBytes: Number(match[1]) * 1024 });
  }
  return volumes;
}

export function parseAccelerators(text: string | null): { gpuPercent: number | null; anePercent: number | null } {
  const read = (name: string) => {
    const match = text?.match(new RegExp(`${name} (?:HW )?active residency:\\s*([\\d.]+)%`, 'i'));
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  };
  return { gpuPercent: read('GPU'), anePercent: read('ANE') };
}
