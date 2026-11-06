/** Queue visits are immutable snapshots; append a newer snapshot on each transition. */
export interface QueueVisit {
  id: string;
  station: string;
  pool: string;
  arrivedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export function isQueueVisit(value: unknown): value is QueueVisit {
  if (!value || typeof value !== 'object') return false;
  const v = value as QueueVisit;
  return [v.id, v.station, v.pool].every(s => typeof s === 'string' && s.length > 0) &&
    Number.isFinite(v.arrivedAt) && v.arrivedAt >= 0 &&
    (v.startedAt === undefined || (Number.isFinite(v.startedAt) && v.startedAt >= v.arrivedAt)) &&
    (v.completedAt === undefined || (v.startedAt !== undefined && Number.isFinite(v.completedAt) && v.completedAt >= v.startedAt));
}

/** Half-open windows [now-windowMs, now); rates / second, durations in seconds.
 * L is time-average total WIP; W is mean residence of departures in the window.
 * Boundary censoring can legitimately cause Little's law drift in short windows.
 */
export function estimateQueueStats(visits: readonly QueueVisit[], now: number, windows = [3600000, 86400000, 604800000]) {
  if (!Number.isFinite(now) || windows.some(w => !Number.isFinite(w) || w <= 0)) throw new Error('Invalid queue window');
  if (visits.some(v => !isQueueVisit(v))) throw new Error('Invalid queue visit');
  const latest = new Map<string, QueueVisit>();
  for (const v of visits) latest.set(JSON.stringify([v.station, v.pool, v.id]), v);
  // Canonical order makes floating-point sums independent of journal arrival order.
  const all = [...latest.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, visit]) => visit).filter(v => v.arrivedAt < now);
  const groups = (key: 'station' | 'pool') => [...new Set(all.map(v => v[key]))].sort().map(name => ({
    [key]: name,
    windows: windows.map(windowMs => {
      const rows = all.filter(v => v[key] === name);
      const since = now - windowMs;
      const seconds = windowMs / 1000;
      const within = (t: number | undefined): t is number => t !== undefined && t >= since && t < now;
      const overlap = (start: number, end: number) => Math.max(0, Math.min(now, end) - Math.max(since, start)) / 1000;
      const arrivals = rows.filter(v => within(v.arrivedAt)).length;
      const done = rows.filter(v => within(v.completedAt));
      const serviceSeconds = done.reduce((sum, v) => sum + (v.completedAt! - v.startedAt!) / 1000, 0);
      const lambda = arrivals / seconds;
      const mu = serviceSeconds > 0 ? done.length / serviceSeconds : null;
      const wait = done.length ? done.reduce((sum, v) => sum + (v.startedAt! - v.arrivedAt) / 1000, 0) / done.length : null;
      const W = done.length ? done.reduce((sum, v) => sum + (v.completedAt! - v.arrivedAt) / 1000, 0) / done.length : null;
      const L = rows.reduce((sum, v) => sum + overlap(v.arrivedAt, v.completedAt ?? now), 0) / seconds;
      const queueLength = rows.reduce((sum, v) => sum + overlap(v.arrivedAt, v.startedAt ?? now), 0) / seconds;
      const expectedL = W === null ? null : lambda * W;
      const drift = expectedL === null ? null : L === 0 && expectedL === 0 ? 0 : L === 0 ? 1 : Math.abs(L - expectedL) / L;
      return {
        windowMs, since, until: now, arrivals, departures: done.length, lambda, mu,
        rho: mu === null ? null : lambda / mu, queueLength, wait, wip: L,
        currentQueueLength: rows.filter(v => v.arrivedAt <= now && (v.startedAt === undefined || v.startedAt > now)).length,
        currentWip: rows.filter(v => v.completedAt === undefined || v.completedAt > now).length,
        littleLaw: { L, W, lambdaW: expectedL, drift, flagged: drift === null ? null : drift > 0.2 },
      };
    }),
  }));
  return { schemaVersion: 1, generatedAt: now, units: { rates: 'per-second', durations: 'seconds' }, stations: groups('station'), pools: groups('pool') };
}
