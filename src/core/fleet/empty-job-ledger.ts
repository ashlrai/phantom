import { ledgerAtMs, ledgerEventName, ledgerJobId, ledgerLane } from './empty-cause.js';

export interface EmptyJob { id: string; lane: string }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function plainLane(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, ' ').trim() : '';
  return text || 'unknown';
}

/** Pure: distinct jobs whose outcome row says empty, inside the window ending at `now`. */
export function emptyJobs(text: string, now: number, hours: number): EmptyJob[] {
  const seen = new Set<string>();
  const jobs: EmptyJob[] = [];
  for (const line of text.split('\n')) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const f = row as Record<string, unknown>;
    if (ledgerEventName(f) !== 'outcome' || f.empty !== true) continue;
    const id = ledgerJobId(f);
    const ts = ledgerAtMs(f);
    // The id names a log file, so refuse anything that could leave the runs dir.
    if (id === null || !SAFE_ID.test(id) || seen.has(id)) continue;
    if (ts === null || ts > now || ts < now - hours * 3600_000) continue;
    seen.add(id);
    jobs.push({ id, lane: plainLane(ledgerLane(f)) });
  }
  return jobs;
}

