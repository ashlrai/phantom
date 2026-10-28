/**
 * data/queue-stats/model.ts — validated view model for the queue-station
 * graph (RQ-QUEUE-5).
 *
 * The payload this parses is exactly what `phm queue stats --json` prints and
 * `GET /api/queue/stats` serves (src/core/queue/stats.ts estimateQueueStats):
 *
 *   { schemaVersion: 1, generatedAt: <epoch ms>, units: {...},
 *     stations: [{ station, windows: [{ windowMs, arrivals, departures,
 *       lambda, mu|null, rho|null, queueLength, wait|null, wip,
 *       currentQueueLength, currentWip, littleLaw: {...} }] }],
 *     pools:    [{ pool, windows: [...] }] }
 *
 * Rates are per second, durations in seconds, window bounds in milliseconds.
 * Only whitelisted fields are copied into the view model, so keys a hostile
 * or buggy producer smuggles in (tokens, URLs, paths) never reach the DOM.
 * Station and pool labels are validated like the journal's own identifier
 * rules before they are rendered as text.
 */

/** Canonical pipeline order from the router-queue station set (RQ-QUEUE-2). */
export const QUEUE_STATION_ORDER = [
  'planned',
  'READY',
  'claimed',
  'publish',
  'pr-ci',
  'merge-queue',
  'merged',
  'released',
  'fix-main',
] as const;

const STATION_LABELS: Record<string, string> = {
  planned: 'planned',
  READY: 'READY',
  claimed: 'claimed',
  publish: 'publish',
  'pr-ci': 'PR CI',
  'merge-queue': 'merge queue',
  merged: 'merged',
  released: 'released',
  'fix-main': 'fix-main',
};

/** Identifiers are short slugs; anything else (tokens, URLs, paths) is rejected. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Shapes that look like credentials even when slug-shaped. */
const SECRET_LIKE = /(sk-|ghp_|gho_|ghs_|glpat-|github_pat_|xox[abp]-|phc_|bearer|token|secret|password|apikey|api_key)/i;

function isSafeName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NAME.test(value) && !SECRET_LIKE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One measured window for one station (or pool), whitelisted. `mu` and `rho`
 * are null when no visit completed service in the window; `wait` is null when
 * no visit completed; `littleDrift` is null when the check had no departures.
 */
export interface QueueWindowMetrics {
  windowMs: number;
  arrivals: number;
  departures: number;
  lambda: number;
  mu: number | null;
  rho: number | null;
  queueLength: number;
  wait: number | null;
  wip: number;
  currentQueueLength: number;
  currentWip: number;
  littleDrift: boolean | null;
}

export interface QueueStationMetrics extends QueueWindowMetrics {
  station: string;
  label: string;
}

export interface QueuePoolMetrics extends QueueWindowMetrics {
  pool: string;
}

export interface QueueStatsView {
  generatedAt: number;
  windowMs: number;
  stations: QueueStationMetrics[];
  pools: QueuePoolMetrics[];
}

export type QueueStatsParse = { ok: true; value: QueueStatsView } | { ok: false; error: string };

function parseWindow(row: Record<string, unknown>): QueueWindowMetrics | null {
  const windowMs = num(row, 'windowMs');
  const arrivals = num(row, 'arrivals');
  const departures = num(row, 'departures');
  const lambda = num(row, 'lambda');
  const queueLength = num(row, 'queueLength');
  const wip = num(row, 'wip');
  const currentQueueLength = num(row, 'currentQueueLength');
  const currentWip = num(row, 'currentWip');
  if (
    windowMs === null || windowMs <= 0 ||
    arrivals === null || arrivals < 0 || departures === null || departures < 0 ||
    lambda === null || lambda < 0 ||
    queueLength === null || queueLength < 0 || wip === null || wip < 0 ||
    currentQueueLength === null || currentQueueLength < 0 ||
    currentWip === null || currentWip < 0
  ) return null;
  const muRaw = row['mu'];
  const rhoRaw = row['rho'];
  const waitRaw = row['wait'];
  const mu = muRaw === null ? null : num(row, 'mu');
  const rho = rhoRaw === null ? null : num(row, 'rho');
  const wait = waitRaw === null ? null : num(row, 'wait');
  if ((muRaw !== null && mu === null) || (rhoRaw !== null && rho === null) || (waitRaw !== null && wait === null)) return null;
  if ((mu !== null && mu < 0) || (rho !== null && rho < 0) || (wait !== null && wait < 0)) return null;
  const little = row['littleLaw'];
  const littleDrift = isRecord(little) && typeof little['flagged'] === 'boolean' ? little['flagged'] : null;
  return { windowMs, arrivals, departures, lambda, mu, rho, queueLength, wait, wip, currentQueueLength, currentWip, littleDrift };
}

/** Read one grouped row; picks the requested window, else the narrowest. */
function parseGroup(raw: unknown, nameKey: 'station' | 'pool', windowMs?: number): (QueueWindowMetrics & { name: string }) | null {
  if (!isRecord(raw)) return null;
  const name = raw[nameKey];
  if (!isSafeName(name)) return null;
  const windows = raw['windows'];
  if (!Array.isArray(windows)) return null;
  const parsed = windows.filter(isRecord).map(parseWindow).filter((w): w is QueueWindowMetrics => w !== null);
  const pick = parsed.find(w => windowMs !== undefined && w.windowMs === windowMs)
    ?? parsed.reduce<QueueWindowMetrics | null>((best, w) => (!best || w.windowMs < best.windowMs) ? w : best, null);
  return pick ? { name, ...pick } : null;
}

/**
 * Validate untrusted JSON into the view model. Stations land in canonical
 * pipeline order; producers may report station ids outside the canonical set
 * — those keep their (safe) names and sort after the known pipeline.
 */
export function parseQueueStats(input: unknown, windowMs?: number): QueueStatsParse {
  if (!isRecord(input)) return { ok: false, error: 'queue stats payload is not an object' };
  if (input['schemaVersion'] !== 1) return { ok: false, error: 'unsupported queue stats schema' };
  const generatedAt = num(input, 'generatedAt');
  if (generatedAt === null) return { ok: false, error: 'queue stats missing generatedAt' };
  if (!Array.isArray(input['stations']) || !Array.isArray(input['pools'])) {
    return { ok: false, error: 'queue stats groups are malformed' };
  }
  const stations: QueueStationMetrics[] = [];
  const pools: QueuePoolMetrics[] = [];
  const seen = new Set<string>();
  for (const raw of input['stations']) {
    const group = parseGroup(raw, 'station', windowMs);
    if (!group || seen.has(group.name)) continue;
    seen.add(group.name);
    const { name, ...metrics } = group;
    stations.push({ station: name, label: STATION_LABELS[name] ?? name, ...metrics });
  }
  for (const raw of input['pools']) {
    const group = parseGroup(raw, 'pool', windowMs);
    if (!group) continue;
    const { name, ...metrics } = group;
    pools.push({ pool: name, ...metrics });
  }
  const order = (name: string): number => {
    const index = (QUEUE_STATION_ORDER as readonly string[]).indexOf(name);
    return index === -1 ? QUEUE_STATION_ORDER.length : index;
  };
  stations.sort((a, b) => order(a.station) - order(b.station) || a.station.localeCompare(b.station));
  pools.sort((a, b) => a.pool.localeCompare(b.pool));
  const pickedWindow = stations[0]?.windowMs ?? pools[0]?.windowMs ?? windowMs ?? 0;
  return { ok: true, value: { generatedAt, windowMs: pickedWindow, stations, pools } };
}

/**
 * Rho bands. Green below 0.7 (queue wait stays near service time), amber from
 * 0.7 to below 0.9 (M/M/1 mean wait is 2.3x to 9x service time), red at 0.9
 * and above (wait grows steeply as rho nears and passes 1). 'unknown' covers
 * rho === null (arrivals happened but no service completed in the window —
 * utilization is undefined, not zero). 'idle' marks stations with no
 * arrivals, no queue and no in-service work at all.
 */
export const RHO_AMBER = 0.7;
export const RHO_RED = 0.9;
export type RhoBand = 'idle' | 'green' | 'amber' | 'red' | 'unknown';

export function isStationActive(station: QueueStationMetrics): boolean {
  return station.arrivals > 0 || station.currentQueueLength > 0 || station.currentWip > 0;
}

export function rhoBand(station: QueueStationMetrics): RhoBand {
  if (!isStationActive(station)) return 'idle';
  if (station.rho === null || !Number.isFinite(station.rho)) return 'unknown';
  if (station.rho >= RHO_RED) return 'red';
  if (station.rho >= RHO_AMBER) return 'amber';
  return 'green';
}

/**
 * Bottleneck: among active stations, the highest rho wins. A station with
 * arrivals or waiting work but no measured service rate (rho null) is treated
 * as saturated — it outranks every finite rho. Ties break on the larger
 * current queue, then earlier pipeline position so the choice is stable.
 * Null when nothing is active.
 */
export function selectBottleneck(stations: readonly QueueStationMetrics[]): string | null {
  let best: QueueStationMetrics | null = null;
  const rank = (s: QueueStationMetrics): number => {
    if (!isStationActive(s)) return -1;
    return s.rho === null ? Number.POSITIVE_INFINITY : s.rho;
  };
  const position = (s: QueueStationMetrics): number => {
    const index = (QUEUE_STATION_ORDER as readonly string[]).indexOf(s.station);
    return index === -1 ? QUEUE_STATION_ORDER.length : index;
  };
  for (const s of stations) {
    const r = rank(s);
    if (r < 0) continue;
    if (!best || r > rank(best)
      || (r === rank(best) && s.currentQueueLength > best.currentQueueLength)
      || (r === rank(best) && s.currentQueueLength === best.currentQueueLength && position(s) < position(best))) {
      best = s;
    }
  }
  return best?.station ?? null;
}
