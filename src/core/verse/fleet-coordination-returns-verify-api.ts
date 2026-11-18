/** Desktop second reader for VERIFIED pr receipts: the same composition as
 * `ashlr fleet returns-check` (retained ledger -> returns projection ->
 * checkReturnPrs), served on demand. Read-only and authority-free: nothing is
 * written, commented or merged. Takes no query, path or root input, and never
 * sends gh or reader error text; unknown verdicts carry only the fixed reason
 * codes from return-pr-check.ts. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import type { Gh } from '../autopilot/github.js';
import { readFleetBoard, type FleetBoard } from '../fleet/coordination.js';
import { projectCoordinationReturns } from '../fleet/coordination-returns-view.js';
import { checkReturnPrs, type ReturnPrCheckReport, type ReturnPrChecked } from '../fleet/return-pr-check.js';
import { VERSE_FLEET_COORDINATION_RETURNS_PATH } from './fleet-coordination-returns-api.js';

export const VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH = `${VERSE_FLEET_COORDINATION_RETURNS_PATH}/verify`;
/** Repeated clicks inside this window reuse the last GitHub sweep. */
export const RETURNS_VERIFY_CACHE_MS = 60_000;

export interface FleetCoordinationReturnsVerifyApiDeps {
  /** Reader seam for tests. Default: retained return history at the observation clock, without reaping. */
  read?: () => FleetBoard;
  /** GitHub seam for tests. Default: the gh CLI. */
  gh?: Gh;
  /** Clock seam for tests. */
  now?: () => Date;
}

export interface ReturnsVerifyBody {
  v: 1;
  authority: 'none';
  /** When this sweep started; a cached answer keeps its original stamp. */
  generatedAt: string;
  asOf: string;
  returnsState: 'known' | 'unknown';
  coverage: { parsedTotal: number | null; omitted: number | null; unparsed: number | null };
  unparsed: number;
  checked: ReturnPrChecked[];
  skipped: number;
  truncated: boolean;
  /** VERIFIED pr receipts outside their [at, expiresAt) window at asOf. */
  nonCurrentReceipts: number;
  /** True only where `ashlr fleet returns-check` would exit 0. */
  complete: boolean;
}

export function createFleetCoordinationReturnsVerifyApi(deps: FleetCoordinationReturnsVerifyApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  type Observation = { at: number; check: ReturnPrCheckReport };
  let cached: (Observation & { key: string }) | null = null;
  let inflight: { key: string; at: number; promise: Promise<Observation> } | null = null;
  let lastAt = -Infinity;

  async function observe(): Promise<ReturnsVerifyBody> {
    const at = now();
    let board: FleetBoard | null;
    // Match the CLI: retain durable returns, excluding expired ordinary posts,
    // at the same clock that qualifies receipt currency in the projection.
    try { board = deps.read ? deps.read() : readFleetBoard({ now: at.getTime(), reap: false, includeExpiredReturns: true }); } catch { board = null; }
    const view = projectCoordinationReturns(board, at.getTime());
    const ms = at.getTime();
    if (ms < lastAt) { cached = null; inflight = null; }
    lastAt = ms;
    // Bounded projection, including provenance and coverage, but excluding temporal
    // qualification: expiry alone does not require another GitHub observation.
    const key = JSON.stringify([view.state, view.coverage, view.returns.map(row => ({ ...row }))]);
    const fresh = (entry: { key: string; at: number } | null) => entry !== null
      && entry.key === key && ms >= entry.at && ms - entry.at < RETURNS_VERIFY_CACHE_MS;
    let observation: Observation;
    if (fresh(cached)) observation = cached!;
    else {
      cached = null;
      if (!fresh(inflight)) {
        const flight = { key, at: ms, promise: checkReturnPrs(view.returns,
          { gh: deps.gh, now: () => now().getTime() }).then(check => ({ at: ms, check })) };
        inflight = flight;
        void flight.promise.then(value => {
          if (inflight === flight && view.state === 'known') cached = { key, ...value };
        }, () => {}).finally(() => { if (inflight === flight) inflight = null; });
      }
      observation = await inflight!.promise;
    }
    const { check } = observation;
    const nonCurrentReceipts = view.returns
      .filter(row => row.result === 'VERIFIED' && row.evidenceKind === 'pr' && row.temporal !== 'current').length;
    const body: ReturnsVerifyBody = {
      v: 1, authority: 'none', generatedAt: new Date(observation.at).toISOString(), asOf: view.asOf,
      returnsState: view.state, coverage: view.coverage, unparsed: view.unparsed,
      checked: check.checked, skipped: check.skipped, truncated: check.truncated, nonCurrentReceipts,
      complete: view.state === 'known' && view.coverage.omitted === 0 && view.coverage.unparsed === 0
        && !check.truncated && nonCurrentReceipts === 0
        && check.checked.every(row => row.verdict === 'merged-at-head'),
    };
    return body;
  }

  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_COORDINATION_RETURNS_VERIFY_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if ((req.url ?? '').includes('?')) {
      sendJson(res, 400, { error: 'query parameters are not accepted' });
      return true;
    }
    try {
      sendJson(res, 200, await observe());
    } catch {
      sendJson(res, 500, { error: 'returns verify failed' });
    }
    return true;
  };
}

export const handleFleetCoordinationReturnsVerifyApi: ApiModule = createFleetCoordinationReturnsVerifyApi();
