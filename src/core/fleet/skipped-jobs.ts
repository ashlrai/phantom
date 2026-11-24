/** `phm jobs skipped`: queued jobs the dispatcher's precheck dropped before launch. The jobs ledger records a numeric code and no
 * reason text, so this names each code in plain words, groups the skips by code and job family, and flags repeat and leader skips.
 * Read-only: it never re-queues a job or edits a queue file. A code it does not know is shown as unknown, never guessed. */
import { join } from 'node:path';
import { readText } from './empty-cause.js';
import { isPrecheckSkipRow } from './jobs-ledger-dialect.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { jobFamily } from './slot-yield.js';

export const SKIPPED_JOBS_SCHEMA = 'jobs.skipped.v1' as const;
export const SKIP_CODE_MEANING: Readonly<Record<number, string>> = {
  10: 'Already merged or closed.',
  11: 'A pull request is open and green.',
  12: 'A duplicate pull request is open.',
  13: 'The files or symbols it names already exist, or its family is stopped.',
};
export const UNKNOWN_SKIP_MEANING = 'unknown';
export const SKIP_DEFAULT_HOURS = 24;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const HOUR = 3_600_000;

export interface SkippedJobV1 { job: string; family: string; lane: string; repo: string; at: string; code: number | null; meaning: string; leader: boolean }
export interface SkipCodeGroupV1 { code: number | null; meaning: string; count: number; jobs: SkippedJobV1[] }
export interface SkipFamilyCountV1 { family: string; count: number }
export interface SkippedJobsV1 {
  schema: typeof SKIPPED_JOBS_SCHEMA; v: 1; hours: number; as_of: string;
  /** False when the jobs ledger could not be read; the lists are then empty and mean nothing. */
  known: boolean;
  total: number;
  by_code: SkipCodeGroupV1[];
  by_family: SkipFamilyCountV1[];
  /** Job ids skipped two or more times in the window. */
  repeated: string[];
  /** Skipped jobs the leader queued: a wrong skip here costs the most. */
  leader_skipped: string[];
}

const text = (v: unknown): string => typeof v === 'string' && v.trim() ? v.trim() : 'unknown';

/** Pure: the skips in the last `hours` of a jobs ledger, newest first within each group. */
export function summarizeSkips(ledger: string | null, now: number, hours = SKIP_DEFAULT_HOURS): SkippedJobsV1 {
  const report: SkippedJobsV1 = { schema: SKIPPED_JOBS_SCHEMA, v: 1, hours, as_of: new Date(now).toISOString(), known: ledger !== null, total: 0, by_code: [], by_family: [], repeated: [], leader_skipped: [] };
  if (ledger === null) return report;
  const rows: Array<SkippedJobV1 & { ms: number }> = [];
  for (const line of ledger.split(/\r?\n/)) {
    if (!line.includes('precheck_skip') && !line.includes('skipped_empty')) continue;
    let row: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      row = v as Record<string, unknown>;
    } catch { continue; }
    const ms = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!isPrecheckSkipRow(row) || typeof row.job !== 'string' || !row.job || !Number.isFinite(ms) || ms < now - hours * HOUR || ms > now) continue;
    const code = typeof row.code === 'number' && Number.isInteger(row.code) ? row.code : null;
    const family = jobFamily(row.job);
    rows.push({ job: row.job, family, lane: text(row.lane ?? row.pool), repo: text(row.repo), at: new Date(ms).toISOString(), code,
      meaning: (code !== null ? SKIP_CODE_MEANING[code] : undefined) ?? UNKNOWN_SKIP_MEANING, leader: row.src === 'leader' || family === 'leader', ms });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const codes = new Map<number | null, SkipCodeGroupV1>(), families = new Map<string, number>(), perJob = new Map<string, number>();
  for (const { ms: _ms, ...row } of rows) {
    const group = codes.get(row.code) ?? { code: row.code, meaning: row.meaning, count: 0, jobs: [] };
    group.count++; group.jobs.push(row); codes.set(row.code, group);
    families.set(row.family, (families.get(row.family) ?? 0) + 1);
    perJob.set(row.job, (perJob.get(row.job) ?? 0) + 1);
  }
  report.total = rows.length;
  // Known codes in numeric order, unknown last.
  report.by_code = [...codes.values()].sort((a, b) => (a.code ?? Infinity) - (b.code ?? Infinity));
  report.by_family = [...families].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
  report.repeated = [...perJob].filter(([, n]) => n >= 2).map(([job]) => job).sort();
  report.leader_skipped = [...new Set(rows.filter(r => r.leader).map(r => r.job))].sort();
  return report;
}

/** Read the jobs ledger once. Read-only. */
export async function readSkippedJobs(opts: { runsDir?: string; now?: number; hours?: number } = {}): Promise<SkippedJobsV1> {
  const now = opts.now ?? Date.now();
  const ledger = await readText(join(opts.runsDir ?? defaultRunsDir(), 'metrics', 'jobs.jsonl'), LEDGER_TAIL_BYTES);
  return summarizeSkips(ledger, now, opts.hours ?? SKIP_DEFAULT_HOURS);
}

/** Plain lines for a terminal. */
export function skippedJobsText(report: SkippedJobsV1): string[] {
  if (!report.known) return ['unknown — the jobs ledger could not be read.'];
  const span = report.hours === 24 ? 'the last 24 hours' : `the last ${report.hours} hours`;
  if (report.total === 0) return [`No jobs were skipped in ${span}.`];
  const out = [`${report.total} ${report.total === 1 ? 'job was' : 'jobs were'} skipped in ${span}.`];
  for (const group of report.by_code) {
    out.push('', `Code ${group.code ?? 'unknown'} (${group.meaning}): ${group.count}`);
    for (const j of group.jobs) out.push(`  ${j.job}  ${j.lane}  ${j.repo}  ${j.at}${j.leader ? '  leader' : ''}`);
  }
  out.push('', 'By job family:', ...report.by_family.map(f => `  ${f.family}: ${f.count}`));
  if (report.repeated.length) out.push('', `Skipped more than once: ${report.repeated.join(', ')}`);
  if (report.leader_skipped.length) out.push(`Queued by the leader: ${report.leader_skipped.join(', ')}`);
  return out;
}
