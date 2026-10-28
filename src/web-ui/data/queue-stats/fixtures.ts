/** Fixture payloads for `queue.stats.v1` (normal, overloaded, empty). */
import type { QueueMetrics, QueueStation } from './schema.js';

function st(lambda: number, c: number, mu: number, L: number, queue_growth_per_h = 0): QueueMetrics {
  const rho = Math.round((lambda / (c * mu)) * 100) / 100;
  return {
    status: 'ok',
    lambda_per_h: lambda,
    mu_per_h: mu,
    c,
    rho,
    L,
    W_h: lambda > 0 ? Math.round((L / lambda) * 100) / 100 : 0,
    WIP: Math.ceil(L),
    little_err_pct: 3,
    queue_growth_per_h,
  };
}
const NA: QueueMetrics = {
  status: 'ok', lambda_per_h: 10, mu_per_h: 0.03, c: null, rho: null, L: 40, W_h: 4, WIP: 40, little_err_pct: 5, queue_growth_per_h: 0,
};

export const QUEUE_STATS_NORMAL = {
  schema: 'queue.stats.v1',
  generated_utc: '2026-10-26T07:00:00.000Z',
  window_h: 1,
  stations: {
    router_queued: st(6, 1, 12, 1),
    claimed: st(6, 1, 10, 2),
    builder_run: st(5, 10, 1, 5),
    publish: st(1, 1, 4, 0),
    pr_open_rework: NA,
    pr_ci: st(30, 4, 9.5, 4, 0.5),
    review: st(4, 2, 5, 1),
    merge_group: st(4, 5, 2, 1),
    release: st(1, 1, 10, 0),
    live: st(1, 1, 20, 0),
    fix_main: st(0.5, 1, 2, 0),
  } satisfies Record<QueueStation, QueueMetrics>,
  pools: [
    { pool: 'codex-cmp', ...st(3, 1, 5, 2) },
    { pool: 'local', ...st(2, 1, 4, 1) },
  ],
  little: { drift: false, ratio: 0.05 },
};

export const QUEUE_STATS_OVERLOADED = {
  schema: 'queue.stats.v1',
  generated_utc: '2026-10-26T07:00:00.000Z',
  window_h: 1,
  stations: {
    router_queued: st(14, 1, 20, 3),
    claimed: st(14, 1, 15, 9, 2),
    builder_run: st(12, 10, 1.3, 6, 1),
    publish: st(2, 1, 3, 1),
    pr_open_rework: NA,
    pr_ci: st(40, 4, 8, 18, 6),
    review: st(10, 2, 5, 11, 3),
    merge_group: st(8, 5, 2, 4, 1),
    release: st(2, 1, 10, 0),
    live: st(2, 1, 20, 0),
    fix_main: st(3, 1, 3, 4, 3),
  } satisfies Record<QueueStation, QueueMetrics>,
  pools: [{ pool: 'codex-cmp', ...st(9, 1, 8, 12, 4) }],
  little: { drift: true, ratio: 0.31 },
};

export const QUEUE_STATS_EMPTY = {
  schema: 'queue.stats.v1',
  generated_utc: '2026-10-26T07:00:00.000Z',
  window_h: 1,
  stations: {},
  pools: [],
  little: { drift: false, ratio: 0 },
};
