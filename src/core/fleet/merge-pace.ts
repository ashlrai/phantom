/** Pure merge-pace report builder shared by the CLI verb and the Verse API. */
/** Returns the raw jobs.jsonl text, or null when unreadable. */
import { parseLedgerTs } from '../metrics/loop.js';

export type MergePaceReader = () => Promise<string | null>;

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

/**
 * jobs.jsonl field dialects, the same sets dispatchd's _vc_* helpers,
 * growth/series.ts mergeRow, metrics/loop.ts jobTimelines and
 * fleet/eval-report.ts foldJobsLedger accept: job ids take
 * job|job_id|jobId|id; the event name event|type|kind; the phase
 * outcome|state|status (outcome first, so a reconciler-swapped outcome beats
 * a stale copied state); timestamps prefer mergedAt on MERGED rows then
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt (dispatchd's
 * %z stamps need parseLedgerTs); PR links url|prUrl|pr_url|pr|html_url; the
 * ledger ttm reads ttm_s|ttmS.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['outcome', 'state', 'status'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const URL_KEYS = ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const;
const TTM_KEYS = ['ttm_s', 'ttmS'] as const;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*\/?$/;

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

/** First parseable stamp; a MERGED row's mergedAt is the GitHub merge instant and wins. */
function mergeTs(row: Record<string, unknown>, phase: string): number | null {
  const fields = phase === 'MERGED' ? ['mergedAt', ...TS_KEYS.filter(k => k !== 'mergedAt')] : TS_KEYS;
  for (const key of fields) {
    const at = parseLedgerTs(row[key]);
    if (at !== null) return at;
  }
  return null;
}

/** Lowercase owner/repo from the row's first GitHub pull URL field, or null. */
function mergeRepo(row: Record<string, unknown>): string | null {
  for (const key of URL_KEYS) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const match = PR_URL.exec(value.trim());
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

function mergeTtm(row: Record<string, unknown>): number | null {
  for (const key of TTM_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Merge evidence in the jobs.jsonl dialect: a terminal outcome/state/status of
 * MERGED counts whatever the event name says — the metrics-outcomes
 * reconciler copies the PUBLISHED row and only swaps the outcome, so its rows
 * keep event:'publish'/'published' beside outcome/status MERGED. A `merged`
 * event counts only when no terminal phase field is present; a contradictory
 * terminal state (CLOSED) still wins over the event name.
 */
function mergeRow(row: Record<string, unknown>): { job: string; at: number; repo: string; ttm: number | null } | null {
  const phase = (firstString(row, PHASE_KEYS) ?? '').toUpperCase();
  const event = (firstString(row, EVENT_KEYS) ?? '').toLowerCase();
  if (phase !== 'MERGED' && !(phase === '' && event === 'merged')) return null;
  const job = firstString(row, JOB_KEYS);
  if (job === null) return null;
  const repo = mergeRepo(row);
  if (repo === null) return null;
  const at = mergeTs(row, phase);
  if (at === null) return null;
  return { job, at, repo, ttm: mergeTtm(row) };
}

/** Last means newest timestamp, with the last ledger row winning ties. */
export async function fleetMergePace(read: MergePaceReader, now = Date.now()): Promise<MergePaceReport> {
  const base = { schema: 'fleet.merge-pace.v1', window_hours: WINDOW_HOURS } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return { ...base, known: false, rows: null };
  const jobs = new Map<string, { at: number; repo: string; ttm: number | null }>();
  for (const line of text.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const merge = mergeRow(parsed as Record<string, unknown>);
    if (!merge || merge.at > now || merge.at < now - WINDOW_HOURS * 3_600_000) continue;
    if ((jobs.get(merge.job)?.at ?? -Infinity) > merge.at) continue;
    jobs.set(merge.job, { at: merge.at, repo: merge.repo, ttm: merge.ttm });
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
