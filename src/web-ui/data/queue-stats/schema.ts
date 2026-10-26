/**
 * data/queue-stats/schema.ts: the `queue.stats.v1` contract.
 *
 * RQ-QUEUE-3 (`phm queue stats --json`) emits exactly this shape; the desktop
 * station graph (RQ-QUEUE-5) parses it. Dependency free so the CLI side can
 * import it without React.
 *
 * Aligned with CI Efficiency's interim estimator `queue_now.v1`
 * (ci-efficiency/queue/queue-now.json, controller-design.md). Shared fields
 * keep queue_now names verbatim: generated_utc, window_h, stations keyed by
 * station id, and per station status, lambda_per_h, mu_per_h, c, rho, L, W_h,
 * WIP, little_err_pct. Fields added by v1: queue_growth_per_h (tie break),
 * pools, little. Fields of queue_now NOT carried: repos, bottleneck (derived
 * here), and the free-text note / c_source (never rendered; may hold
 * anything).
 */

export const QUEUE_STATS_SCHEMA = 'queue.stats.v1' as const;

/** The 11 stations in flow order (controller-design.md line 5); fix_main is the side station. */
export const QUEUE_STATIONS = [
  'router_queued',
  'claimed',
  'builder_run',
  'publish',
  'pr_open_rework',
  'pr_ci',
  'review',
  'merge_group',
  'release',
  'live',
  'fix_main',
] as const;
export type QueueStation = (typeof QUEUE_STATIONS)[number];

export const STATION_LABELS: Record<QueueStation, string> = {
  router_queued: 'router queued',
  claimed: 'claimed',
  builder_run: 'builder run',
  publish: 'publish',
  pr_open_rework: 'PR open/rework',
  pr_ci: 'PR CI',
  review: 'review',
  merge_group: 'merge group',
  release: 'release',
  live: 'live',
  fix_main: 'fix-main',
};

export const STATION_STATUSES = ['ok', 'partial', 'no data'] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

/** Per station or pool metrics. Null or absent means "not measured yet". */
export interface QueueMetrics {
  status: StationStatus;
  lambda_per_h: number | null;
  mu_per_h: number | null;
  /** Servers; null when unknown or infinite-server. */
  c: number | null;
  /** lambda / (c * mu); null when c is unknown (rho n/a). */
  rho: number | null;
  /** Time-average number in station (queue length). */
  L: number | null;
  /** Mean sojourn in hours. */
  W_h: number | null;
  WIP: number | null;
  little_err_pct: number | null;
  /** Change in L per hour (positive = growing). */
  queue_growth_per_h: number | null;
}

export interface QueuePoolStats extends QueueMetrics {
  pool: string;
}

export interface QueueStatsV1 {
  schema: typeof QUEUE_STATS_SCHEMA;
  generated_utc: string;
  window_h: number;
  stations: Partial<Record<QueueStation, QueueMetrics>>;
  pools: QueuePoolStats[];
  /** Little's law check: drift when any station's little_err_pct > 20; ratio = max err / 100. */
  little: { drift: boolean; ratio: number };
}

export type ParseResult = { ok: true; value: QueueStatsV1 } | { ok: false; error: string };

const NUM_KEYS = ['lambda_per_h', 'mu_per_h', 'c', 'rho', 'L', 'W_h', 'WIP', 'little_err_pct', 'queue_growth_per_h'] as const;
const SIGNED = new Set<string>(['queue_growth_per_h']);
export const LITTLE_DRIFT_PCT = 20;
/** Pool ids are short slugs; anything else (tokens, URLs, paths) is rejected. */
const POOL_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const SECRET_LIKE = /(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|phc_|bearer|token|secret|password|apikey|api_key)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSafePoolId(id: string): boolean {
  return POOL_ID.test(id) && !SECRET_LIKE.test(id);
}

function readMetrics(raw: Record<string, unknown>, where: string): QueueMetrics | string {
  const out: Record<string, unknown> = {};
  for (const key of NUM_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) {
      out[key] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${where}.${key} must be a finite number or null`;
    if (!SIGNED.has(key) && v < 0) return `${where}.${key} must be >= 0`;
    out[key] = v;
  }
  const status = raw.status ?? 'ok';
  if (typeof status !== 'string' || !(STATION_STATUSES as readonly string[]).includes(status)) {
    return `${where}.status must be one of ${STATION_STATUSES.join(', ')}`;
  }
  out.status = status;
  return out as unknown as QueueMetrics;
}

/**
 * Validate untrusted JSON into `queue.stats.v1`. Only whitelisted fields are
 * copied, so unknown keys (which could carry tokens) never reach the UI.
 */
export function parseQueueStats(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'payload must be an object' };
  if (input.schema !== QUEUE_STATS_SCHEMA) return { ok: false, error: `schema must be ${QUEUE_STATS_SCHEMA}` };
  const generated_utc = input.generated_utc;
  if (typeof generated_utc !== 'string' || Number.isNaN(Date.parse(generated_utc))) {
    return { ok: false, error: 'generated_utc must be an ISO timestamp' };
  }
  const window_h = input.window_h;
  if (typeof window_h !== 'number' || !Number.isFinite(window_h) || window_h <= 0) {
    return { ok: false, error: 'window_h must be > 0' };
  }
  if (!isRecord(input.stations)) return { ok: false, error: 'stations must be an object keyed by station id' };
  if (!Array.isArray(input.pools)) return { ok: false, error: 'pools must be an array' };

  const stations: Partial<Record<QueueStation, QueueMetrics>> = {};
  for (const [id, raw] of Object.entries(input.stations)) {
    if (!(QUEUE_STATIONS as readonly string[]).includes(id)) return { ok: false, error: `stations.${id} is not a known station` };
    if (!isRecord(raw)) return { ok: false, error: `stations.${id} must be an object` };
    const m = readMetrics(raw, `stations.${id}`);
    if (typeof m === 'string') return { ok: false, error: m };
    stations[id as QueueStation] = m;
  }

  const pools: QueuePoolStats[] = [];
  for (const [i, raw] of input.pools.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `pools[${i}] must be an object` };
    const pool = raw.pool;
    if (typeof pool !== 'string' || !isSafePoolId(pool)) return { ok: false, error: `pools[${i}].pool is not a safe pool id` };
    const m = readMetrics(raw, `pools[${i}]`);
    if (typeof m === 'string') return { ok: false, error: m };
    pools.push({ pool, ...m });
  }

  const little = input.little;
  if (!isRecord(little) || typeof little.drift !== 'boolean' || typeof little.ratio !== 'number' || !Number.isFinite(little.ratio)) {
    return { ok: false, error: 'little must be { drift: boolean, ratio: number }' };
  }

  return {
    ok: true,
    value: { schema: QUEUE_STATS_SCHEMA, generated_utc, window_h, stations, pools, little: { drift: little.drift, ratio: little.ratio } },
  };
}

/**
 * Rho bands, aligned with the controller's HOT/COLD hysteresis
 * (controller-design.md: HOT at rho >= 0.85, COLD at rho <= 0.70).
 * green < 0.70, amber 0.70 to < 0.85, red >= 0.85 (or non-finite);
 * unknown when rho is null (c not known, or no data).
 */
export const RHO_AMBER = 0.7;
export const RHO_RED = 0.85;
export type RhoBand = 'green' | 'amber' | 'red' | 'unknown';

export function rhoBand(rho: number | null): RhoBand {
  if (rho === null) return 'unknown';
  if (!Number.isFinite(rho) || rho >= RHO_RED) return 'red';
  if (rho >= RHO_AMBER) return 'amber';
  return 'green';
}

export const RHO_COLORS: Record<RhoBand, string> = { green: '#2e9e5b', amber: '#d99a1e', red: '#d64545', unknown: '#7a7f87' };

/**
 * Bottleneck: highest rho over stations with a known rho; ties broken by the
 * fastest-growing queue (queue_growth_per_h), then larger L, then flow order.
 * Null when no station has rho > 0.
 */
export function selectBottleneck(stations: Partial<Record<QueueStation, QueueMetrics>>): QueueStation | null {
  let best: QueueStation | null = null;
  let bm: QueueMetrics | null = null;
  for (const id of QUEUE_STATIONS) {
    const m = stations[id];
    if (!m || m.rho === null || m.rho <= 0) continue;
    if (!bm || m.rho > bm.rho!) {
      best = id;
      bm = m;
      continue;
    }
    if (m.rho !== bm.rho) continue;
    const g = m.queue_growth_per_h ?? 0;
    const bg = bm.queue_growth_per_h ?? 0;
    if (g > bg || (g === bg && (m.L ?? 0) > (bm.L ?? 0))) {
      best = id;
      bm = m;
    }
  }
  return best;
}
