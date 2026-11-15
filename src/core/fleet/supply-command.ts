import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planSupply, readIssues, readRoadmap, readTodos, type SupplyCandidate, type SupplySource } from './supply.js';

const usage = 'Usage: phm fleet supply --lane <lane> --n <1-100> [--json]';
export async function cmdFleetSupplyWork(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let lane = '', n = 0, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--lane' && !lane) lane = args[++i] ?? '';
    else if (args[i] === '--n' && !n && /^[1-9]\d{0,2}$/.test(args[i + 1] ?? '')) n = Number(args[++i]);
    else { console.error(usage); return 2; }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(lane) || n < 1 || n > 100) { console.error(usage); return 2; }
  const sources: Record<string, SupplySource> = {};
  const candidates: SupplyCandidate[] = [];
  const scans = await Promise.allSettled([readIssues(), readRoadmap(process.cwd()), readTodos(process.cwd())]);
  for (const [i, name] of ['issues', 'roadmap', 'todos'].entries()) {
    const scan = scans[i]!;
    sources[name] = scan.status === 'fulfilled' ? { status: 'ok', count: scan.value.length } : { status: 'unknown', count: null };
    if (scan.status === 'fulfilled') candidates.push(...scan.value);
  }
  let queue: string | null = null;
  try { queue = await readFile(join(homedir(), '.ashlr-runs', 'queue', 'router-queue.md'), 'utf8'); } catch { /* Unknown queue must not produce duplicates. */ }
  sources.queue = { status: queue === null ? 'unknown' : 'ok', count: null };
  const lines = queue === null ? [] : planSupply(candidates, queue, lane, n);
  const report = { schema: 'fleet.supply-work.v1', requested: n, emitted: lines.length, gap: n - lines.length, sources, lines };
  if (json) console.log(JSON.stringify(report));
  else {
    for (const line of lines) console.log(line);
    console.log(`Requested ${n}; found ${lines.length}; gap ${n - lines.length}.`);
    for (const [name, source] of Object.entries(sources)) console.log(`${name}: ${source.status === 'unknown' ? 'unknown' : source.count ?? 'available'}`);
  }
  return 0;
}
