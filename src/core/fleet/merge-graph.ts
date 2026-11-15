/** Hourly merge observations shared by the CLI and console. */
export interface MergeGraphBucket { start: string; merges: number; medianSeconds: number | null }
export interface MergeGraphReport {
  schema: 'metrics.merges.v1'; known: boolean; windowHours: 24;
  lanes: { lane: string; buckets: MergeGraphBucket[] }[] | null;
}
const HOUR = 3_600_000;
export function mergeGraph(raw: string | null, now = Date.now()): MergeGraphReport {
  const base = { schema: 'metrics.merges.v1', windowHours: 24 } as const;
  if (raw === null) return { ...base, known: false, lanes: null };
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = end - 24 * HOUR;
  const launches = new Map<string, { lane: string; at: number }>();
  const merges = new Map<string, { lane: string | null; at: number; seconds: number | null }>();
  for (const line of raw.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; row = parsed as Record<string, unknown>; } catch { continue; }
    const id = row.job ?? row.job_id;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (typeof id !== 'string' || !id.trim() || !Number.isFinite(at) || at > now) continue;
    const lane = typeof row.lane === 'string' && row.lane.trim() ? row.lane.trim() : null;
    if (row.event === 'launch' && lane && at >= (launches.get(id)?.at ?? -Infinity)) launches.set(id, { lane, at });
    if (row.event !== 'outcome' || row.state !== 'MERGED' || at < start || at >= end || at < (merges.get(id)?.at ?? -Infinity)) continue;
    const seconds = typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0 ? row.ttm_s : null;
    merges.set(id, { lane, at, seconds });
  }
  const groups = new Map<string, { count: number; times: number[] }[]>();
  for (const [id, merge] of merges) {
    const launch = launches.get(id);
    const lane = merge.lane ?? (launch && launch.at <= merge.at ? launch.lane : null) ?? 'unknown';
    let buckets = groups.get(lane);
    if (!buckets) { buckets = Array.from({ length: 24 }, () => ({ count: 0, times: [] })); groups.set(lane, buckets); }
    const bucket = buckets[Math.floor((merge.at - start) / HOUR)]!;
    bucket.count++;
    if (merge.seconds !== null) bucket.times.push(merge.seconds);
  }
  return { ...base, known: true, lanes: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([lane, buckets]) => ({ lane, buckets: buckets.map((bucket, i) => {
    const times = bucket.times.sort((a, b) => a - b), middle = Math.floor(times.length / 2);
    return { start: new Date(start + i * HOUR).toISOString(), merges: bucket.count, medianSeconds: times.length ? times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2 : null };
  }) })) };
}
