/** Merges per hour and median time to merge over the last six hours, from the jobs metrics ledger. */
import { readJobsMetrics, type JobsMetricsReader } from './jobs-metrics.js';

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
export async function fleetMergePace(read: JobsMetricsReader = readJobsMetrics, now = Date.now()): Promise<MergePaceReport> {
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
