import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet skip-forecast [--hours 6] [--json]\nList the top 10 repo and file pairs with code 13 skips. Reads local records only.';
export interface SkipForecastReaders {
  readJobs: () => Promise<string>;
  readQueue: () => Promise<string>;
  now: () => number;
}
export interface SkipForecastReport {
  schema: 'fleet.skip-forecast.v1';
  hours: number;
  matched_skips: number;
  unmatched_skips: number;
  top_paths: { repo: string; path: string; skip_count: number }[];
}

/** Counts recorded skips, not predicted future events. No queue or ledger writes. */
export async function readSkipForecast(hours: number, readers: SkipForecastReaders): Promise<SkipForecastReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Hours must be positive.');
  const now = readers.now();
  const [jobs, queue] = await Promise.all([readers.readJobs(), readers.readQueue()]);
  const paths = new Map<string, string>();
  for (const line of queue.split(/\r?\n/)) {
    const id = /^-\s+(?:\S+\s+)*?([A-Za-z0-9._-]+)\s+\([^)]*\)/.exec(line)?.[1];
    const path = /`([^`\r\n]+)`/.exec(line)?.[1];
    if (id && path && !paths.has(id)) paths.set(id, path);
  }
  const counts = new Map<string, SkipForecastReport['top_paths'][number]>();
  let matched = 0, unmatched = 0;
  for (const line of jobs.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    if (row.event !== 'precheck_skip' || row.code !== 13) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at < now - hours * 3_600_000 || at > now) continue;
    const path = typeof row.job === 'string' ? paths.get(row.job) : undefined;
    if (!path || typeof row.repo !== 'string' || !row.repo.trim()) { unmatched++; continue; }
    const key = JSON.stringify([row.repo, path]);
    const entry = counts.get(key) ?? { repo: row.repo, path, skip_count: 0 };
    entry.skip_count++; counts.set(key, entry); matched++;
  }
  return { schema: 'fleet.skip-forecast.v1', hours, matched_skips: matched, unmatched_skips: unmatched,
    top_paths: [...counts.values()].sort((a, b) => b.skip_count - a.skip_count
      || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path)).slice(0, 10) };
}

export async function cmdFleetSkipForecast(args: string[], injected: Partial<SkipForecastReaders> = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 6, seenHours = false, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && args[i + 1]) {
      hours = Number(args[++i]); seenHours = true;
      if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  const root = join(homedir(), '.ashlr-runs');
  try {
    const report = await readSkipForecast(hours, {
      readJobs: () => readFile(join(root, 'metrics', 'jobs.jsonl'), 'utf8'),
      readQueue: () => readFile(join(root, 'queue', 'router-queue.md'), 'utf8'),
      now: Date.now, ...injected,
    });
    console.log(json ? JSON.stringify(report) : report.top_paths.length
      ? report.top_paths.map(row => `${row.repo} ${row.path}: ${row.skip_count} skips`).join('\n')
      : `No matching skips in the last ${hours} hours.`);
    return 0;
  } catch { console.error('Unable to read skip records or router queue.'); return 1; }
}
