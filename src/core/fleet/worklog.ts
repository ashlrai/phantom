import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorklogEntry {
  job: string | null; repo: string | null; lane: string | null; model: string | null;
  kind: 'launch' | 'finished' | 'pr' | 'empty' | 'failed' | 'merged'; at: string;
  mergedAt: string | null; openToMergeSeconds: number | null; url: string | null;
}
export interface WorklogReport { schema: 'worklog.v2'; entries: WorklogEntry[]; malformedLines: number }
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
type Row = Record<string, unknown>;
const timestamp = (row: Row) => str(row.ts ?? row.timestamp ?? row.at);
const jobId = (row: Row) => str(row.job ?? row.job_id ?? row.jobId);
function prUrl(row: Row): string | null {
  const value = str(row.url ?? row.prUrl ?? row.pr_url);
  return value && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(value) ? value.replace(/\/$/, '') : null;
}
function eventKind(row: Row): WorklogEntry['kind'] | null {
  if (row.event === 'launch') return 'launch';
  if (row.event === 'merged' || (row.event === 'outcome' && row.state === 'MERGED')) return 'merged';
  if (row.event === 'publish' && prUrl(row)) return 'pr';
  if (row.event !== 'finish') return null;
  if (typeof row.exit_code === 'number' && Number.isFinite(row.exit_code) && row.exit_code !== 0) return 'failed';
  if (prUrl(row)) return 'pr';
  return row.empty === true ? 'empty' : 'finished';
}

export function worklogHours(value = '24h'): number {
  const hours = Number(value.slice(0, -1));
  if (!/^\d+(?:\.\d+)?h$/.test(value) || hours <= 0 || !Number.isFinite(hours * 3600000)) throw new Error('Use a positive number of hours, for example 1h.');
  return hours;
}

/** Extend the existing jobs projection; a successful finish alone is not proof of a PR. */
export function worklog(text: string, since: number, now: number): WorklogReport {
  const rows: Row[] = []; let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      rows.push(row as Row);
    } catch { malformedLines++; }
  }
  const launches = new Map<string, Row[]>();
  const publications = new Map<string, Row>();
  for (const row of rows) {
    const id = jobId(row);
    if (id && row.event === 'launch') launches.set(id, [...(launches.get(id) ?? []), row]);
    const url = prUrl(row);
    if (id && url && row.event === 'publish') publications.set(url.toLowerCase(), row);
  }
  const entries: WorklogEntry[] = [];
  for (const row of rows) {
    const kind = eventKind(row);
    if (!kind) continue;
    const recordedAt = timestamp(row); const at = recordedAt ? Date.parse(recordedAt) : NaN;
    if (!recordedAt || !Number.isFinite(at)) { malformedLines++; continue; }
    if (at < since || at > now) continue;
    const url = prUrl(row);
    const publication = url ? publications.get(url.toLowerCase()) : undefined;
    const job = jobId(row) ?? (publication && Date.parse(timestamp(publication) ?? '') <= at ? jobId(publication) : null);
    // A retry launched while a PR waited to merge belongs to a later attempt.
    const publishedAt = publication ? Date.parse(timestamp(publication) ?? '') : NaN;
    const launchBefore = kind === 'merged' && publication && jobId(publication) === job && publishedAt <= at ? publishedAt : at;
    const launch = job ? (launches.get(job) ?? []).filter(r => {
      const time = timestamp(r); return time && Number.isFinite(Date.parse(time)) && Date.parse(time) <= launchBefore;
    }).sort((a, b) => Date.parse(timestamp(b)!) - Date.parse(timestamp(a)!))[0] : undefined;
    const repo = str(row.repo ?? launch?.repo) ?? (url ? new URL(url).pathname.split('/')[2] ?? null : null);
    const seconds = row.ttm_s;
    entries.push({ job, repo, lane: str(row.lane ?? launch?.lane), model: str(row.model ?? launch?.model), kind, at: recordedAt,
      mergedAt: kind === 'merged' ? recordedAt : null,
      openToMergeSeconds: kind === 'merged' && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null, url });
  }
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    if (!entry.url || (entry.kind !== 'merged' && entry.kind !== 'pr')) return true;
    const key = `${entry.kind}:${entry.url.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { schema: 'worklog.v2', entries: unique, malformedLines };
}
export async function readWorklog(hours = 24): Promise<WorklogReport> {
  let text: string;
  try { text = await readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; text = ''; }
  const now = Date.now(); return worklog(text, now - hours * 3600000, now);
}

export function filterWorklog(entries: WorklogEntry[], repo?: string, lane?: string): WorklogEntry[] {
  return entries.filter(e => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane));
}
