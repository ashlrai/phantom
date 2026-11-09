/**
 * data/queue-stats/queue-now.ts: adapter from CI Efficiency's interim
 * estimator output `queue_now.v1` to `queue.stats.v1`.
 *
 * Mapping: schema queue_now.v1 -> queue.stats.v1; generated_utc, window_h and
 * station fields copied by name; stations without a status get 'ok';
 * queue_growth_per_h = null (queue_now has no trend yet); pools = [] (not in
 * queue_now); little.drift = any station little_err_pct > 20, little.ratio =
 * max little_err_pct / 100. Dropped: repos, bottleneck, n_arrivals, n_done,
 * note, c_source (free text is never rendered). Output still goes through
 * parseQueueStats, so unknown stations or bad numbers are rejected.
 */
import { LITTLE_DRIFT_PCT, parseQueueStats, type ParseResult } from './schema.js';

const COPY = ['status', 'lambda_per_h', 'mu_per_h', 'c', 'rho', 'L', 'W_h', 'WIP', 'little_err_pct'] as const;

export function queueNowToStats(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'queue_now payload must be an object' };
  const q = input as Record<string, unknown>;
  if (q.schema !== 'queue_now.v1') return { ok: false, error: 'schema must be queue_now.v1' };
  const rawStations = q.stations;
  if (typeof rawStations !== 'object' || rawStations === null || Array.isArray(rawStations)) {
    return { ok: false, error: 'queue_now stations must be an object' };
  }
  const stations: Record<string, Record<string, unknown>> = {};
  let maxErr = 0;
  for (const [id, raw] of Object.entries(rawStations as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: `queue_now stations.${id} must be an object` };
    const r = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { queue_growth_per_h: null };
    for (const k of COPY) if (k in r) out[k] = r[k];
    if (typeof r.little_err_pct === 'number' && Number.isFinite(r.little_err_pct)) maxErr = Math.max(maxErr, r.little_err_pct);
    stations[id] = out;
  }
  return parseQueueStats({
    schema: 'queue.stats.v1',
    generated_utc: q.generated_utc,
    window_h: q.window_h,
    stations,
    pools: [],
    little: { drift: maxErr > LITTLE_DRIFT_PCT, ratio: maxErr / 100 },
  });
}
