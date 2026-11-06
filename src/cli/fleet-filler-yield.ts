/** Read-only yield of author-filler jobs per repo from the host jobs ledger. Exit 1 when any repo is red. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet filler-yield [--hours 6] [--json]';
const SKIP_CODE = 13;
const RED_MIN_ROWS = 10;
/** Author filler: RQ-, capital letters, digits, A, digits, Q8. */
export const FILLER_ID = /^RQ-[A-Z]+[0-9]+A[0-9]+Q8$/;

export interface FillerYieldRow {
  repo: string;
  launches: number;
  skips: number;
  empty_finishes: number;
  merged: number;
  /** All filler rows seen for the repo in the window, of any event; the red test uses this. */
  rows: number;
  /** merged / (launches + skips); null when there are neither. */
  yield: number | null;
  red: boolean;
}
export interface FillerYieldReport {
  schema: 'fleet.filler-yield.v1';
  window_hours: number;
  /** false when the ledger could not be read; rows is then empty and red false. */
  known: boolean;
  red: boolean;
  repos: FillerYieldRow[];
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** Counts merged once per job, since outcome rows repeat; the repo comes from the row or the job's launch row. */
export async function fleetFillerYield(read: TaskCheckReader = readTaskCheckJobs, hours = 6, now = Date.now()): Promise<FillerYieldReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: FillerYieldReport = { schema: 'fleet.filler-yield.v1', window_hours: hours, known: false, red: false, repos: [] };
  let raw: string | null;
  try { raw = await read(); } catch { raw = null; }
  if (raw === null) return report;
  const parsed: { row: Record<string, unknown>; id: string; at: number }[] = [];
  const launchRepo = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const id = text(r.job ?? r.job_id ?? r.id);
    const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (id === null || !FILLER_ID.test(id) || !Number.isFinite(at)) continue;
    const repo = text(r.repo);
    if (r.event === 'launch' && repo !== null) launchRepo.set(id, repo);
    parsed.push({ row: r, id, at });
  }
  const repos = new Map<string, FillerYieldRow>();
  const mergedJobs = new Set<string>();
  for (const { row, id, at } of parsed) {
    if (at > now || at < now - hours * 3_600_000) continue;
    const name = text(row.repo) ?? launchRepo.get(id) ?? 'unknown';
    const entry = repos.get(name) ?? { repo: name, launches: 0, skips: 0, empty_finishes: 0, merged: 0, rows: 0, yield: null, red: false };
    repos.set(name, entry);
    entry.rows++;
    if (row.event === 'launch') entry.launches++;
    else if (row.event === 'precheck_skip' && Number(row.code) === SKIP_CODE) entry.skips++;
    else if (row.event === 'finish' && row.empty === true) entry.empty_finishes++;
    else if (row.event === 'outcome' && row.state === 'MERGED' && !mergedJobs.has(id)) { mergedJobs.add(id); entry.merged++; }
  }
  for (const entry of repos.values()) {
    const attempts = entry.launches + entry.skips;
    entry.yield = attempts > 0 ? entry.merged / attempts : null;
    entry.red = entry.rows >= RED_MIN_ROWS && entry.skips * 2 > entry.rows;
  }
  report.known = true;
  report.repos = [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  report.red = report.repos.some(entry => entry.red);
  return report;
}

export async function cmdFleetFillerYield(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPer repo, count author-filler jobs (RQ-<LETTERS><digits>A<digits>Q8) in the window: launches, precheck skips with code ${SKIP_CODE}, empty finishes and MERGED outcomes. Yield is merged over launches plus skips. A repo is red when skips are over half of its ${RED_MIN_ROWS}+ rows; exit 1 on red. Reads ~/.ashlr-runs/metrics/jobs.jsonl; unreadable metrics are unknown (exit 0).`);
    return 0;
  }
  let hours = 6, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetFillerYield(read, hours, now);
  const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(!report.known ? 'Filler yield: unknown (metrics unreadable)'
    : report.repos.length === 0 ? `Filler yield: no filler rows in the last ${hours} hours`
    : report.repos.map(r => `${r.repo}: yield ${pct(r.yield)} (${r.merged} merged / ${r.launches} launches + ${r.skips} skips), ${r.empty_finishes} empty finishes${r.red ? ' RED' : ''}`).join('\n')));
  return report.red ? 1 : 0;
}
