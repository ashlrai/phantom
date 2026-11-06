import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet ttm [--hours 24] [--json]';
type Row = Record<string, unknown>;
type Entry = { row: Row; at: number };
export interface FleetTtmDependencies {
  read: (path: string) => Promise<string>;
  now: () => number;
}

/** Outcome time selects merges; latest OPEN outcomes are counted across all ages.
 * Median averages the middle pair; p90 uses the nearest rank. Missing labels stay unknown. */
export function fleetTtm(text: string, hours: number, now: number) {
  const launches = new Map<string, Entry>(), outcomes = new Map<string, Entry>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      const r = row as Row, id = r.job ?? r.job_id ?? r.jobId;
      if (r.event !== 'launch' && r.event !== 'outcome') continue;
      const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (typeof id !== 'string' || !id || !Number.isFinite(at) || at > now) throw new Error();
      const map = r.event === 'launch' ? launches : outcomes;
      if (!map.has(id) || map.get(id)!.at <= at) map.set(id, { row: r, at });
    } catch { ignored++; }
  }
  const repos = new Map<string, number[]>(), lanes = new Map<string, number[]>();
  let openOver30m = 0;
  const label = (value: unknown) => typeof value === 'string' && value.trim() ? value : 'unknown';
  const add = (map: Map<string, number[]>, key: string, value: number) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const [id, { row, at }] of outcomes) {
    if (row.state === 'OPEN' && now - at > 30 * 60_000) openOver30m++;
    if (row.state !== 'MERGED' || at < now - hours * 3_600_000
      || typeof row.ttm_s !== 'number' || !Number.isFinite(row.ttm_s) || row.ttm_s < 0) continue;
    const launch = launches.get(id)?.row;
    add(repos, label(row.repo ?? launch?.repo), row.ttm_s);
    add(lanes, label(launch?.lane), row.ttm_s);
  }
  const summarize = (map: Map<string, number[]>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => {
    values.sort((a, b) => a - b);
    const n = values.length;
    return { name, jobs: n, median_ttm_s: (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2,
      p90_ttm_s: values[Math.ceil(n * 0.9) - 1]! };
  });
  return { schema: 'fleet.ttm.v1', hours, by_repo: summarize(repos), by_lane: summarize(lanes),
    open_over_30m: openOver30m, ignored_rows: ignored };
}

export async function cmdFleetTtm(args: string[], deps: FleetTtmDependencies = {
  read: path => readFile(path, 'utf8'), now: Date.now,
}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nTime to merge in seconds by repo and lane. Counts latest OPEN outcomes older than 30 minutes across all ages.`);
    return 0;
  }
  let hours = 24, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && args[i + 1] && Number.isFinite(Number(args[i + 1])) && Number(args[i + 1]) > 0) {
      hours = Number(args[++i]); seenHours = true;
    } else { console.error(usage); return 2; }
  }
  try {
    const report = fleetTtm(await deps.read(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')), hours, deps.now());
    console.log(json ? JSON.stringify(report) : [
      `Time to merge (last ${hours} hours, seconds)`,
      ...(['by_repo', 'by_lane'] as const).flatMap(key => [key === 'by_repo' ? 'By repo' : 'By lane',
        ...report[key].map(r => `${r.name}: ${r.jobs} jobs, median ${r.median_ttm_s}, p90 ${r.p90_ttm_s}`)]),
      `Open over 30 minutes: ${report.open_over_30m}`,
    ].join('\n'));
    return 0;
  } catch { console.error('Unable to read jobs ledger.'); return 1; }
}
