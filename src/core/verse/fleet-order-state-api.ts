/** Read-only desktop surface for `ashlr fleet order-state --json`: each of
 * Mason's inbox orders classified RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED from the real order trace, served as a sub-path of the work-board
 * family (chained from fleet-work-board-api.ts) so no new route family is
 * registered. Reads local files only, writes nothing, and never returns order
 * text bodies, file paths or a thrown message: an unreadable trace answers
 * 200 with sources 'unavailable' and no orders. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { parseOrderAt } from '../../cli/fleet-orders.js';
import { classifyOrder, mostAdvancedJob } from '../fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../fleet/order-trace.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const VERSE_FLEET_ORDER_STATE_PATH = '/api/verse/fleet/work-board/orders';

const LIMIT = 20;
const MAX_SINCE_HOURS = 720;

export interface FleetOrderStateApiDeps {
  /** Reader seam for tests. Default: readOrderTrace(). */
  read?: (opts: { now?: () => number }) => Promise<OrderTraceV1>;
  /** Clock seam for tests; stamps asOf and feeds the classifier. */
  now?: () => Date;
}

export function createFleetOrderStateApi(deps: FleetOrderStateApiDeps = {}): ApiModule {
  const read = deps.read ?? ((opts) => readOrderTrace(opts));
  const now = deps.now ?? (() => new Date());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_ORDER_STATE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let params: URLSearchParams;
    try {
      params = new URL(req.url ?? path, 'http://localhost').searchParams;
    } catch {
      params = new URLSearchParams();
    }
    const rawSince = params.get('since');
    let since: number | undefined;
    if (rawSince !== null) {
      const hours = /^\d+$/.test(rawSince) ? Number(rawSince) : NaN;
      if (!(hours >= 1 && hours <= MAX_SINCE_HOURS)) {
        sendJson(res, 400, { error: `since must be an integer number of hours, 1-${MAX_SINCE_HOURS}.` });
        return true;
      }
      since = hours;
    }
    const ms = now().getTime();
    const nowMs = Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
    const nowIso = new Date(nowMs).toISOString();
    let trace: OrderTraceV1;
    try {
      trace = await read({ now: () => nowMs });
    } catch {
      sendJson(res, 200, { v: 1, asOf: nowIso, sources: 'unavailable', orders: [] });
      return true;
    }
    let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
    if (since !== undefined) {
      const cutoff = nowMs - since * 3600_000;
      orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= cutoff; });
    }
    sendJson(res, 200, sanitizePublicJson({
      v: 1,
      generatedAt: trace.generatedAt,
      asOf: nowIso,
      sources: trace.sources,
      orders: orders.slice(0, LIMIT).map((o) => {
        const c = classifyOrder(o, trace.generatedAt, nowIso);
        return {
          at: o.at, source: o.source, key: o.key,
          state: c.state, asOf: c.asOf, evidenceSource: c.source,
          missing: c.missing, pr: mostAdvancedJob(o)?.url ?? null,
        };
      }),
    }));
    return true;
  };
}

export const handleFleetOrderStateApi: ApiModule = createFleetOrderStateApi();
