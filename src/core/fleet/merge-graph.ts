/** Hourly merge observations shared by the CLI and console. */
import { parseLedgerTs } from '../metrics/loop.js';

export interface MergeGraphBucket { start: string; merges: number; medianSeconds: number | null }
export interface MergeGraphReport {
  schema: 'metrics.merges.v1'; known: boolean; windowHours: 24;
  lanes: { lane: string; buckets: MergeGraphBucket[] }[] | null;
}
const HOUR = 3_600_000;

/**
 * jobs.jsonl field dialects, the same sets dispatchd's _vc_* helpers,
 * metrics/loop.ts jobTimelines and fleet/eval-report.ts foldJobsLedger
 * accept: job ids take job|job_id|jobId|id; the event name event|type|kind;
 * the phase outcome|state|status plus the producer aliases
 * phase|result|conclusion (outcome first, so a reconciler-swapped
 * outcome beats a stale copied state); timestamps prefer mergedAt on MERGED
 * rows then ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt
 * (dispatchd's %z stamps need parseLedgerTs); the lane alias pool|arm; the
 * ledger ttm reads ttm_s|ttmS.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['outcome', 'state', 'status', 'phase', 'result', 'conclusion'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const TTM_KEYS = ['ttm_s', 'ttmS'] as const;

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

/** First parseable stamp; a MERGED row's mergedAt is the GitHub merge instant and wins. */
function ledgerTs(row: Record<string, unknown>, phase: string): number | null {
  const fields = phase === 'MERGED' ? ['mergedAt', ...TS_KEYS.filter(k => k !== 'mergedAt')] : TS_KEYS;
  for (const key of fields) {
    const at = parseLedgerTs(row[key]);
    if (at !== null) return at;
  }
  return null;
}

function ledgerTtm(row: Record<string, unknown>): number | null {
  for (const key of TTM_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

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
    const id = firstString(row, JOB_KEYS);
    if (id === null) continue;
    const phase = (firstString(row, PHASE_KEYS) ?? '').toUpperCase();
    const event = (firstString(row, EVENT_KEYS) ?? '').toLowerCase();
    // A terminal outcome/state/status of MERGED is merge evidence whatever the
    // event name says — the metrics-outcomes reconciler copies the PUBLISHED
    // row and only swaps the outcome, so its rows keep event:'publish' beside
    // outcome/status MERGED. A `merged` event counts only with no phase, and a
    // contradictory terminal state still wins over the event name.
    const isMerge = phase === 'MERGED' || (phase === '' && event === 'merged');
    const at = ledgerTs(row, phase);
    if (at === null || at > now) continue;
    const lane = firstString(row, LANE_KEYS);
    if (event === 'launch' && lane !== null && at >= (launches.get(id)?.at ?? -Infinity)) launches.set(id, { lane, at });
    if (!isMerge || at < start || at >= end || at < (merges.get(id)?.at ?? -Infinity)) continue;
    merges.set(id, { lane, at, seconds: ledgerTtm(row) });
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
