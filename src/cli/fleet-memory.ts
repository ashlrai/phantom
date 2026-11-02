/** Read-only host memory view; never changes dispatch or memguard state. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetMemoryFiles, type FleetMemoryFiles } from '../core/fleet/memory-files.js';
import { memoryView, type FleetMemoryView } from '../core/fleet/memory-view.js';

const usage = 'Usage: ashlr fleet memory [--root <dir>] [--json]';

export { readFleetMemoryFiles };
export type { FleetMemoryFiles };

const field = (value: number | string | null): string => value === null ? 'unknown' : String(value);
const age = (ms: number | null): string => {
  if (ms === null) return 'unknown';
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.round(ms / 1000)}s`;
  if (abs < 7_200_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

export function formatFleetMemory(view: FleetMemoryView): string {
  return [
    `free_pct: ${field(view.sample.free_pct)}`,
    `swap_gb: ${field(view.sample.swap_gb)}`,
    `swapouts_per_min: ${field(view.sample.swapouts_per_min)}`,
    `disk_gb: ${field(view.sample.disk_gb)}`,
    `sampled_at: ${field(view.sample.sampled_at)}`,
    `sample_age: ${age(view.sample.age_ms)}`,
    `stale: ${view.sample.stale === null ? 'unknown' : view.sample.stale ? 'yes' : 'no'}`,
    `memguard_level: ${field(view.memguard.level)}`,
    `memguard_stopped: ${view.memguard.stopped === null ? 'unknown' : view.memguard.stopped.length ? view.memguard.stopped.join(', ') : 'none'}`,
  ].join('\n');
}

export async function cmdFleetMemory(args: string[], readFiles = readFleetMemoryFiles, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nHost memory and memguard state: free percent, swap, swapouts, disk, sample age, guard level and stopped job ids. Reads <root>/memstat.json and <root>/.memguard2.json (default ~/.ashlr-runs); missing or malformed files report unknown fields. A sample older than five minutes is marked stale.`);
    return 0;
  }
  let root = join(homedir(), '.ashlr-runs');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--root'].includes(arg)) {
      console.error(`error: invalid fleet memory arguments\n${usage}`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--json') json = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(`error: --root needs a directory\n${usage}`); return 2; }
      root = value;
    }
  }
  let view;
  try {
    const files = await readFiles(root);
    view = memoryView(files.memstat, files.memguard, now);
  } catch {
    console.error('fleet memory: samples unavailable');
    return 1;
  }
  console.log(json ? JSON.stringify(view) : formatFleetMemory(view));
  return 0;
}
