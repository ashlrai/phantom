/** Projection from decimal-GB disk-growth samples; job counts are context, not causation. */
export interface DiskForecast {
  schema: 'fleet.disk-forecast.v1';
  status: 'projected' | 'reached' | 'not-falling' | 'unknown';
  thresholdGb: 150;
  samples: number;
  freeGb: number | null;
  observedFrom: string | null;
  observedTo: string | null;
  consumptionGbPerHour: number | null;
  hoursUntilThreshold: number | null;
  crossingAt: string | null;
  launchedJobs: number | null;
}

type Sample = { at: number; free: number };
export function diskForecast(storage: string | null, jobs: string | null, now = Date.now()): DiskForecast {
  const result: DiskForecast = { schema: 'fleet.disk-forecast.v1', status: 'unknown', thresholdGb: 150,
    samples: 0, freeGb: null, observedFrom: null, observedTo: null, consumptionGbPerHour: null,
    hoursUntilThreshold: null, crossingAt: null, launchedJobs: null };
  let data: unknown;
  try { data = JSON.parse(storage ?? ''); } catch { return result; }
  if (!Array.isArray(data)) return result;
  const samples = new Map<number, Sample>();
  for (const row of data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { at, free_gb: free } = row as Record<string, unknown>;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at * 1000 > now ||
        typeof free !== 'number' || !Number.isFinite(free) || free < 0) continue;
    samples.set(at, { at, free });
  }
  const rows = [...samples.values()].sort((a, b) => a.at - b.at);
  result.samples = rows.length;
  const first = rows[0], last = rows.at(-1);
  if (!first || !last) return result;
  result.freeGb = last.free;
  result.observedTo = new Date(last.at * 1000).toISOString();
  if (first.at !== last.at) {
    result.observedFrom = new Date(first.at * 1000).toISOString();
    result.consumptionGbPerHour = (first.free - last.free) * 3600 / (last.at - first.at);
    if (jobs !== null) {
      const ids = new Set<string>();
      for (const line of jobs.split(/\r?\n/)) {
        try {
          const row: unknown = JSON.parse(line);
          if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
          const r = row as Record<string, unknown>;
          const id = r.job ?? r.job_id ?? r.jobId, time = r.ts ?? r.timestamp ?? r.at;
          const ms = typeof time === 'string' ? Date.parse(time) : NaN;
          if (r.event === 'launch' && typeof id === 'string' && id && ms > first.at * 1000 && ms <= last.at * 1000) ids.add(id);
        } catch { /* ignore malformed ledger rows */ }
      }
      result.launchedJobs = ids.size;
    }
  }
  if (last.free <= 150) { result.status = 'reached'; result.hoursUntilThreshold = 0; result.crossingAt = result.observedTo; }
  else if (result.consumptionGbPerHour !== null && result.consumptionGbPerHour > 0) {
    const hours = (last.free - 150) / result.consumptionGbPerHour;
    const crossing = last.at * 1000 + hours * 3_600_000;
    if (Number.isFinite(crossing) && crossing <= 8.64e15) {
      result.status = 'projected'; result.hoursUntilThreshold = hours; result.crossingAt = new Date(crossing).toISOString();
    }
  } else if (result.consumptionGbPerHour !== null) result.status = 'not-falling';
  return result;
}
