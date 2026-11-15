/**
 * routes/verse/fleet-board/order-execution-join.ts — joins each order row's
 * owner job to the live claim-execution evidence served by
 * GET /api/verse/fleet/runtime-identity/claim-execution
 * (src/core/verse/fleet-claim-execution-api.ts). A claim names the job a
 * worker TOOK; this read says whether a worker process is actually RUNNING
 * it right now — an ASSIGNED or RUNNING order only claims execution when
 * current evidence says so, never from intent alone.
 *
 * The response shape is declared here on purpose: the web bundle must not
 * import src/core. A read that fails or a body that is not the
 * claim-execution envelope at all (a 404 from an older server, a foreign
 * v:1 payload) yields no suffix — the strip only opines on real
 * claim-execution evidence, so an unreadable read can never hide, promote
 * or alter an order row.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatAge } from '../fleet-host/runtime-identity-model.js';

export const ORDER_CLAIM_EXECUTION_PATH = '/api/verse/fleet/runtime-identity/claim-execution';

/** Local mirror of src/core/fleet/claim-execution-evidence.ts (fleet.claim-execution.v1). */
export interface OrderClaimExecutionWorker {
  pid: number;
  lane: string;
  tier: string;
  ageSeconds: number | null;
}

export interface OrderClaimExecutionRow {
  claimId: string;
  agent: string;
  repo: string;
  jobId: string | null;
  state: 'RUNNING' | 'CLAIMED_NO_WORKER' | 'UNKNOWN';
  worker: OrderClaimExecutionWorker | null;
  expiresInSeconds: number;
}

export interface OrderClaimExecutionReport {
  schema: string;
  authority: 'none';
  asOf: string;
  ledger: 'known' | 'unavailable';
  processes: 'healthy' | 'unavailable';
  rows: OrderClaimExecutionRow[];
  counts: { running: number; claimedNoWorker: number; unknown: number };
  reasons: string[];
}

export interface OrderClaimExecutionBody {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: OrderClaimExecutionReport;
}

/**
 * One read of the claim-execution route, polled by the strip every 30 s while
 * the section is visible. A 404 (older server without the route), a network
 * error or a refused read resolve to `null` — never to fabricated evidence.
 */
export const orderClaimExecutionQuery: QueryDef<unknown> = {
  key: 'verse-fleet-board-claim-execution',
  async fetch(signal) {
    try {
      return await apiGet<unknown>(ORDER_CLAIM_EXECUTION_PATH, signal);
    }
    catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  },
};

/** Lane labels are short safe tokens; anything else is shown as 'unknown lane'. */
const LANE_TEXT = /^[A-Za-z0-9._-]{1,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A non-negative finite age in seconds, or null when the row carries none. */
const usableAge = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * The process contract's usable-worker check applied client-side: only a
 * positive safe-integer pid is live-worker evidence. Lane and ageSeconds are
 * kept raw — a bad lane renders 'unknown lane' and a bad age 'age unknown'
 * rather than sinking an otherwise-live worker.
 */
function usableWorker(raw: unknown): { pid: number; lane: unknown; ageSeconds: unknown } | null {
  if (!isObject(raw)) return null;
  const pid = raw.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, lane: raw.lane, ageSeconds: raw.ageSeconds };
}

const AGE_NONE = Number.POSITIVE_INFINITY;
const ageOrder = (v: unknown): number => usableAge(v) ?? AGE_NONE;

/**
 * One-line execution suffix for an order row's owner span, or null when
 * there is nothing honest to show.
 *  - null: no owner job, or the body is a different v:1 payload (no claim-
 *    execution report — the strip can say nothing about execution);
 *  - 'execution unknown': the read failed or the evidence cannot be trusted —
 *    missing/garbage body, wrong schema version, a degraded ledger or process
 *    table, a broken rows payload, or every matching row murky (UNKNOWN, or
 *    RUNNING without a usable worker pid);
 *  - 'running pid N on <lane>, <age>': youngest usable RUNNING match;
 *  - 'no live worker': matching rows are all CLAIMED_NO_WORKER;
 *  - 'no live claim': a healthy report carries no row for this job.
 */
export function orderExecutionText(ownerJob: string | null | undefined, body: unknown): string | null {
  if (typeof ownerJob !== 'string' || ownerJob === '') return null;
  if (!isObject(body) || body.v !== 1) return 'execution unknown';
  const report = body.report;
  // A v:1 body without a report object is a foreign payload, not degraded
  // claim-execution evidence — the strip must not read it as one.
  if (!isObject(report)) return null;
  if (report.ledger !== 'known' || report.processes !== 'healthy' || !Array.isArray(report.rows)) {
    return 'execution unknown';
  }
  let matched = false;
  let murky = false;
  let best: { pid: number; lane: unknown; ageSeconds: unknown } | null = null;
  for (const raw of report.rows) {
    if (!isObject(raw) || raw.jobId !== ownerJob) continue;
    matched = true;
    if (raw.state === 'RUNNING') {
      const worker = usableWorker(raw.worker);
      if (worker === null) murky = true;
      else if (best === null || ageOrder(worker.ageSeconds) < ageOrder(best.ageSeconds)) best = worker;
    }
    else if (raw.state !== 'CLAIMED_NO_WORKER') {
      murky = true;
    }
  }
  if (best !== null) {
    const lane = typeof best.lane === 'string' && LANE_TEXT.test(best.lane) ? best.lane : 'unknown lane';
    const age = usableAge(best.ageSeconds);
    return `running pid ${best.pid} on ${lane}, ${age === null ? 'age unknown' : formatAge(age)}`;
  }
  if (!matched) return 'no live claim';
  return murky ? 'execution unknown' : 'no live worker';
}
