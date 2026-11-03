/** Read-only merge counts and time to merge over the last six hours. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';

const usage = 'Usage: ashlr fleet merge-pace [--json]';
const WINDOW_HOURS = 6;
export interface MergePaceRow {
  repo: string;
  merges: number;
  merges_per_hour: number;
  median_ttm_s: number | null;
}
export interface MergePaceReport {
  schema: 'fleet.merge-pace.v1';
  known: boolean;
  window_hours: 6;
  rows: MergePaceRow[] | null;
}

function summarize(repo: string, times: (number | null)[]): MergePaceRow {
  const values = times.filter((n): n is number => n !== null).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { repo, merges: times.length, merges_per_hour: times.length / WINDOW_HOURS,
    median_ttm_s: values.length ? values.length % 2 ? values[middle]! : values[middle - 1]! / 2 + values[middle]! / 2 : null };
}

/** Last means newest timestamp, with the last ledger row winning ties. */
export async function fleetMergePace(read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<MergePaceReport> {
  const base = { schema: 'fleet.merge-pace.v1', window_hours: WINDOW_HOURS } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return { ...base, known: false, rows: null };
  const jobs = new Map<string, { at: number; repo: string; ttm: number | null }>();
  for (const line of text.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row.event !== 'outcome' || row.state !== 'MERGED' || typeof row.job !== 'string' || !row.job.trim()) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at > now || at < now - WINDOW_HOURS * 3_600_000) continue;
    const match = typeof row.url === 'string'
      ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*\/?$/.exec(row.url) : null;
    if (!match || (jobs.get(row.job)?.at ?? -Infinity) > at) continue;
    jobs.set(row.job, { at, repo: match[1]!.toLowerCase(),
      ttm: typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0 ? row.ttm_s : null });
  }
  const repos = new Map<string, (number | null)[]>();
  const all: (number | null)[] = [];
  for (const { repo, ttm } of jobs.values()) {
    const times = repos.get(repo) ?? [];
    times.push(ttm);
    repos.set(repo, times);
    all.push(ttm);
  }
  return { ...base, known: true, rows: [...repos].sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, times]) => summarize(repo, times)).concat(summarize('total', all)) };
}

export async function cmdFleetMergePace(args: string[], read?: TaskCheckReader, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShow merges, merges per hour and median time to merge in seconds by repo, plus a total, over the last 6 hours. Reads ~/.ashlr-runs/metrics/jobs.jsonl. Counts the latest MERGED outcome per job; missing or invalid times are excluded from medians. Unreadable metrics are unknown.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) {
    console.error(`error: invalid fleet merge-pace arguments\n${usage}`);
    return 2;
  }
  const report = await fleetMergePace(read, now);
  console.log(args.includes('--json') ? JSON.stringify(report) : report.rows === null ? 'Merge pace: unknown (metrics unreadable)'
    : report.rows.map(row => `${row.repo}: ${row.merges} merges, ${row.merges_per_hour.toFixed(2)} per hour, median time to merge: ${row.median_ttm_s ?? 'unknown'} seconds`).join('\n'));
  return 0;
}
