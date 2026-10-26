/**
 * data/queue-stats/schema.ts: the `queue.stats.v1` contract.
 *
 * RQ-QUEUE-3 (`phm queue stats --json`) emits exactly this shape; the desktop
 * station graph (RQ-QUEUE-5) parses it. Kept dependency free so the CLI side
 * can import it without pulling React.
 */

export const QUEUE_STATS_SCHEMA = 'queue.stats.v1' as const;

/** Station order from RQ-QUEUE-1/2 (planned through released, fix-main last). */
export const QUEUE_STATIONS = [
  'planned',
  'ready',
  'claimed',
  'pr_ci',
  'merge_queue',
  'merged',
  'publish',
  'released',
  'fix_main',
] as const;
export type QueueStation = (typeof QUEUE_STATIONS)[number];

export const STATION_LABELS: Record<QueueStation, string> = {
  planned: 'planned',
  ready: 'READY',
  claimed: 'claimed',
  pr_ci: 'PR CI',
  merge_queue: 'merge queue',
  merged: 'merged',
  publish: 'publish',
  released: 'released',
  fix_main: 'fix-main',
};

export interface QueueStatsMetrics {
  /** Arrivals per hour over the window. */
  lambda: number;
  /** Service completions per hour over the window. */
  mu: number;
  /** Utilization lambda/mu; may exceed 1 when overloaded. */
  rho: number;
  queueLength: number;
  /** Mean wait in seconds. */
  waitSec: number;
  wip: number;
  /** Queue length change per hour (positive = growing). Used for tie breaks. */
  queueGrowthPerHour: number;
}

export interface QueueStationStats extends QueueStatsMetrics {
  station: QueueStation;
}

export interface QueuePoolStats extends QueueStatsMetrics {
  pool: string;
}

export interface QueueStatsV1 {
  schema: typeof QUEUE_STATS_SCHEMA;
  generatedAt: string;
  windowSec: number;
  stations: QueueStationStats[];
  pools: QueuePoolStats[];
  /** Little's law check: |L - lambda*W| / L over 20% sets drift. */
  little: { drift: boolean; ratio: number };
}

export type ParseResult = { ok: true; value: QueueStatsV1 } | { ok: false; error: string };

const METRIC_KEYS = ['lambda', 'mu', 'rho', 'queueLength', 'waitSec', 'wip', 'queueGrowthPerHour'] as const;
const NON_NEGATIVE = new Set(['lambda', 'mu', 'rho', 'queueLength', 'waitSec', 'wip']);
/** Pool ids are short slugs; anything else (tokens, URLs, paths) is rejected. */
const POOL_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** Shapes that look like credentials even when slug-shaped. */
const SECRET_LIKE = /(sk-|ghp_|gho_|ghs_|github_pat_|xox[abp]-|phc_|bearer|token|secret|password|apikey|api_key)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readMetrics(raw: Record<string, unknown>, where: string): QueueStatsMetrics | string {
  const out: Partial<QueueStatsMetrics> = {};
  for (const key of METRIC_KEYS) {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${where}.${key} must be a finite number`;
    if (NON_NEGATIVE.has(key) && v < 0) return `${where}.${key} must be >= 0`;
    out[key] = v;
  }
  return out as QueueStatsMetrics;
}

/** True when a pool id may be shown; secret-shaped ids are never rendered. */
export function isSafePoolId(id: string): boolean {
  return POOL_ID.test(id) && !SECRET_LIKE.test(id);
}

/**
 * Validate untrusted JSON into `queue.stats.v1`. Only whitelisted fields are
 * copied, so unknown keys (which could carry tokens) never reach the UI.
 */
export function parseQueueStats(input: unknown): ParseResult {
  if (!isRecord(input)) return { ok: false, error: 'payload must be an object' };
  if (input.schema !== QUEUE_STATS_SCHEMA) return { ok: false, error: `schema must be ${QUEUE_STATS_SCHEMA}` };
  const generatedAt = input.generatedAt;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) {
    return { ok: false, error: 'generatedAt must be an ISO timestamp' };
  }
  const windowSec = input.windowSec;
  if (typeof windowSec !== 'number' || !Number.isFinite(windowSec) || windowSec <= 0) {
    return { ok: false, error: 'windowSec must be > 0' };
  }
  if (!Array.isArray(input.stations)) return { ok: false, error: 'stations must be an array' };
  if (!Array.isArray(input.pools)) return { ok: false, error: 'pools must be an array' };

  const stations: QueueStationStats[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of input.stations.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `stations[${i}] must be an object` };
    const station = raw.station;
    if (typeof station !== 'string' || !(QUEUE_STATIONS as readonly string[]).includes(station)) {
      return { ok: false, error: `stations[${i}].station is not a known station` };
    }
    if (seen.has(station)) return { ok: false, error: `stations[${i}].station is duplicated` };
    seen.add(station);
    const m = readMetrics(raw, `stations[${i}]`);
    if (typeof m === 'string') return { ok: false, error: m };
    stations.push({ station: station as QueueStation, ...m });
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

  stations.sort((a, b) => QUEUE_STATIONS.indexOf(a.station) - QUEUE_STATIONS.indexOf(b.station));
  return {
    ok: true,
    value: { schema: QUEUE_STATS_SCHEMA, generatedAt, windowSec, stations, pools, little: { drift: little.drift, ratio: little.ratio } },
  };
}

/**
 * Rho bands. Green below 0.7 (queue wait stays near service time), amber from
 * 0.7 to below 0.9 (M/M/1 wait is 2.3x to 9x service time), red at 0.9 and
 * above (wait grows without bound as rho nears 1).
 */
export const RHO_AMBER = 0.7;
export const RHO_RED = 0.9;
export type RhoBand = 'green' | 'amber' | 'red';

export function rhoBand(rho: number): RhoBand {
  if (!Number.isFinite(rho) || rho >= RHO_RED) return 'red';
  if (rho >= RHO_AMBER) return 'amber';
  return 'green';
}

export const RHO_COLORS: Record<RhoBand, string> = { green: '#2e9e5b', amber: '#d99a1e', red: '#d64545' };

/**
 * Bottleneck: highest rho; ties broken by fastest-growing queue, then by
 * station order (earliest wins) so the choice is deterministic. Null when
 * there are no stations or every station is idle (rho 0, no queue).
 */
export function selectBottleneck(stations: readonly QueueStationStats[]): QueueStation | null {
  let best: QueueStationStats | null = null;
  for (const s of stations) {
    if (s.rho <= 0 && s.queueLength <= 0) continue;
    if (
      !best ||
      s.rho > best.rho ||
      (s.rho === best.rho && s.queueGrowthPerHour > best.queueGrowthPerHour) ||
      (s.rho === best.rho &&
        s.queueGrowthPerHour === best.queueGrowthPerHour &&
        QUEUE_STATIONS.indexOf(s.station) < QUEUE_STATIONS.indexOf(best.station))
    ) {
      best = s;
    }
  }
  return best ? best.station : null;
}
