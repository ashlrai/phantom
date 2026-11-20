/**
 * Job-metrics ledger row vocabulary shared by the fleet readers.
 *
 * `metrics/jobs.jsonl` rows arrive in more than one dialect. The
 * `metrics-outcomes` reconciler (`contrib/mac/metrics-outcomes`) copies each
 * PUBLISHED row into a terminal MERGED/CLOSED row without an
 * `event:"outcome"` marker: the copy keeps the published row's fields — often
 * `event:"publish"` or no event at all, `jobId`/`prUrl` instead of
 * `job`/`url` — and adds `source:"metrics-outcomes-reconciler"` plus the
 * terminal `outcome`/`status`. `contrib/mac/batcher.py` (`project_row`) and
 * `incident-gate.ts` project those rows back to outcome rows at read time;
 * these helpers apply the same projection so every TypeScript reader agrees
 * on which rows are launches, outcomes and merges.
 */

const RECONCILER_SOURCE = 'metrics-outcomes-reconciler';
/** Terminal states the metrics-outcomes reconciler writes onto copied publish rows. */
const RECONCILER_TERMINAL: ReadonlySet<string> = new Set(['MERGED', 'CLOSED']);

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The job id a ledger row carries across its dialects (`job`, `jobId`, `job_id`, `id`), or null. */
export function ledgerJobId(row: Record<string, unknown>): string | null {
  for (const key of ['job', 'jobId', 'job_id', 'id'] as const) {
    const value = text(row[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The event a ledger row resolves to at read time, or null when it names none.
 * A reconciler row with a terminal `outcome`/`status` projects to `outcome`
 * whatever event the copied publish row carried; an event-less row carrying an
 * `outcome`/`status`/`state` marker is an outcome row too (incident-gate's rule).
 */
export function ledgerEvent(row: Record<string, unknown>): string | null {
  let event = text(row.event);
  const terminal = ['outcome', 'status'].some(key => {
    const value = text(row[key]);
    return value !== null && RECONCILER_TERMINAL.has(value.toUpperCase());
  });
  if (row.source === RECONCILER_SOURCE && terminal) event = 'outcome';
  if (event === null && (text(row.outcome) !== null || text(row.status) !== null || text(row.state) !== null)) event = 'outcome';
  return event;
}

/**
 * The state an outcome row resolves to, trimmed and uppercased, or null.
 * Reconciler rows are publish copies, so their `outcome`/`status` wins over an
 * inherited `state` — the precedence `batcher.project_row` applies; other rows
 * read `state`, `outcome`, then `status` (the order the autonomy fold honors).
 */
export function ledgerOutcomeState(row: Record<string, unknown>): string | null {
  const keys = row.source === RECONCILER_SOURCE ? ['outcome', 'status', 'state'] : ['state', 'outcome', 'status'];
  for (const key of keys) {
    const value = text(row[key]);
    if (value !== null) return value.toUpperCase();
  }
  return null;
}

/** The PR URL an outcome row carries across its dialects (`url`, `prUrl`, `pr_url`, `pr`), or null. */
export function ledgerPrUrl(row: Record<string, unknown>): string | null {
  for (const key of ['url', 'prUrl', 'pr_url', 'pr'] as const) {
    const value = text(row[key]);
    if (value !== null) return value;
  }
  return null;
}
