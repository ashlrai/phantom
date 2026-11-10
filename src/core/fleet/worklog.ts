import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorklogEntry {
  job: string | null; repo: string | null; lane: string | null; model: string | null;
  mergedAt: string; openToMergeSeconds: number | null; url: string | null;
}
export interface WorklogReport { schema: 'worklog.v1'; entries: WorklogEntry[]; malformedLines: number }
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
type Row = Record<string, unknown>;

/** Project recorded outcomes; missing evidence remains null. */
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
  for (const row of rows) {
    const id = str(row.job ?? row.job_id ?? row.jobId);
    if (id && row.event === 'launch') launches.set(id, [...(launches.get(id) ?? []), row]);
  }
  const entries: WorklogEntry[] = [];
  for (const row of rows) {
    if (row.event !== 'outcome' || row.state !== 'MERGED') continue;
    const mergedAt = str(row.ts); const at = mergedAt ? Date.parse(mergedAt) : NaN;
    if (!mergedAt || !Number.isFinite(at) || at < since || at > now) continue;
    const job = str(row.job ?? row.job_id ?? row.jobId);
    const launch = job ? (launches.get(job) ?? []).filter(r => {
      const time = str(r.ts); return !time || (Number.isFinite(Date.parse(time)) && Date.parse(time) <= at);
    }).sort((a, b) => Date.parse(str(b.ts) ?? '1970-01-01') - Date.parse(str(a.ts) ?? '1970-01-01'))[0] : undefined;
    const rawUrl = str(row.url);
    const url = rawUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/.test(rawUrl) ? rawUrl : null;
    const repo = str(row.repo ?? launch?.repo) ?? (url ? new URL(url).pathname.split('/')[2] ?? null : null);
    const seconds = row.ttm_s;
    entries.push({ job, repo, lane: str(row.lane ?? launch?.lane), model: str(row.model ?? launch?.model), mergedAt,
      openToMergeSeconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null, url });
  }
  entries.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    if (!entry.url) return true;
    const key = entry.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { schema: 'worklog.v1', entries: unique, malformedLines };
}
export async function readWorklog(hours = 24): Promise<WorklogReport> {
  const text = await readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8');
  const now = Date.now(); return worklog(text, now - hours * 3600000, now);
}

export function filterWorklog(entries: WorklogEntry[], repo?: string, lane?: string): WorklogEntry[] {
  return entries.filter(e => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane));
}
