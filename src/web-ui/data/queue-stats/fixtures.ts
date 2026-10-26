/** Fixture payloads for `queue.stats.v1` (normal, overloaded, empty). */
import type { QueueStation } from './schema.js';

function st(station: QueueStation, lambda: number, mu: number, queueLength: number, queueGrowthPerHour = 0) {
  const rho = mu > 0 ? Math.round((lambda / mu) * 100) / 100 : 0;
  const waitSec = lambda > 0 ? Math.round((queueLength / lambda) * 3600) : 0;
  return { station, lambda, mu, rho, queueLength, waitSec, wip: queueLength + Math.min(1, lambda), queueGrowthPerHour };
}

export const QUEUE_STATS_NORMAL = {
  schema: 'queue.stats.v1',
  generatedAt: '2026-10-26T07:00:00.000Z',
  windowSec: 3600,
  stations: [
    st('planned', 6, 12, 2),
    st('ready', 6, 10, 3),
    st('claimed', 5, 9, 2),
    st('pr_ci', 5, 6, 4, 0.5),
    st('merge_queue', 4, 8, 1),
    st('merged', 4, 20, 0),
    st('publish', 1, 4, 0),
    st('released', 1, 10, 0),
    st('fix_main', 0.5, 2, 0),
  ],
  pools: [
    { pool: 'codex-cmp', lambda: 3, mu: 5, rho: 0.6, queueLength: 2, waitSec: 2400, wip: 3, queueGrowthPerHour: 0 },
    { pool: 'local', lambda: 2, mu: 4, rho: 0.5, queueLength: 1, waitSec: 1800, wip: 2, queueGrowthPerHour: 0 },
  ],
  little: { drift: false, ratio: 0.06 },
} as const;

export const QUEUE_STATS_OVERLOADED = {
  schema: 'queue.stats.v1',
  generatedAt: '2026-10-26T07:00:00.000Z',
  windowSec: 3600,
  stations: [
    st('planned', 14, 20, 3),
    st('ready', 14, 15, 9, 2),
    st('claimed', 12, 13, 6, 1),
    st('pr_ci', 12, 10, 18, 6),
    st('merge_queue', 10, 10, 11, 3),
    st('merged', 8, 20, 0),
    st('publish', 2, 3, 1),
    st('released', 2, 10, 0),
    st('fix_main', 3, 3, 4, 3),
  ],
  pools: [{ pool: 'codex-cmp', lambda: 9, mu: 8, rho: 1.13, queueLength: 12, waitSec: 4800, wip: 13, queueGrowthPerHour: 4 }],
  little: { drift: true, ratio: 0.31 },
} as const;

export const QUEUE_STATS_EMPTY = {
  schema: 'queue.stats.v1',
  generatedAt: '2026-10-26T07:00:00.000Z',
  windowSec: 3600,
  stations: [],
  pools: [],
  little: { drift: false, ratio: 0 },
} as const;
