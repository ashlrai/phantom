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
    if (f.event !== 'outcome' || f.empty !== true) continue;
    const id = typeof f.job === 'string' ? f.job : f.id;
    const ts = typeof f.ts === 'string' ? Date.parse(f.ts.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
    // The id names a log file, so refuse anything that could leave the runs dir.
    if (typeof id !== 'string' || !SAFE_ID.test(id) || seen.has(id)) continue;
    if (Number.isNaN(ts) || ts > now || ts < now - hours * 3600_000) continue;
    seen.add(id);
    jobs.push({ id, lane: plainLane(f.lane) });
  }
  return jobs;
}

