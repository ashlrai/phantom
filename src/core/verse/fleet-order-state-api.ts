/** Read-only desktop surface for `ashlr fleet order-state --json`: each of
 * Mason's inbox orders classified RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED from the real order trace (each row names its sanitized owner job + lane), served as a sub-path of the work-board
 * family (chained from fleet-work-board-api.ts) so no new route family is
 * registered. Reads local files and one fresh live-worker snapshot per
 * request (the same listLiveWorkers evidence the CLI uses, so RUNNING is
 * reachable here too), plus one fresh lane-targets read per request (the
 * same readLaneTargets/slots.json evidence the CLI uses, so an order whose
 * every job is queued on a held lane reports BLOCKED with a sanitized lane
 * dependency), writes nothing, and never returns order text bodies,
 * file paths, worker command lines, hold reasons or a thrown message: an
 * unreadable trace answers 200 with sources 'unavailable' and no orders,
 * and an unavailable live or lanes read degrades to live/lanes
 * 'unavailable' without failing the request or claiming BLOCKED. Every
 * reader is time-bounded (8 s default, timeoutMs seam for tests) so a hung
 * local evidence read degrades instead of stalling the endpoint; a slow
 * reader that settles after the bound is never trusted. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { parseOrderAt } from '../../cli/fleet-orders.js';
import { classifyWorkItem } from '../comms/work-item-state.js';
import { orderEvidence, mostAdvancedJob, type LiveJobIds } from '../fleet/order-work-state.js';
import { heldLaneBlocker } from '../fleet/order-lane-blocker.js';
import { readOrderTrace, type OrderTraceV1 } from '../fleet/order-trace.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../fleet/runs-live-workers.js';
import { readLaneTargets, type LaneTargetsV1 } from '../fleet/runs-lane-targets.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const VERSE_FLEET_ORDER_STATE_PATH = '/api/verse/fleet/work-board/orders';

const LIMIT = 20;
const OWNER_JOB = /^RQ-[A-Z0-9][A-Z0-9-]{0,79}$/;
const OWNER_LANE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Per-reader bound: a hung trace, live or lanes read degrades instead of
 * stalling the desktop endpoint. */
export const VERSE_FLEET_ORDER_STATE_TIMEOUT_MS = 8_000;

/** Bounded read: a throw or timeout rejects so the caller can degrade. The
 * timer is cleared on settle, and a reader that finishes or rejects after
 * the bound is already handled by the race — never a second response. */
async function bounded<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Owner row = { job, lane } for the public boundary, emitted only when the
 * job id is a plain RQ id and the lane a lower-case lane id. */
function ownerOf(job: { id: string; lane: string | null } | undefined): { job: string; lane: string | null } | null {
  if (job === undefined || !OWNER_JOB.test(job.id)) return null;
  return { job: job.id, lane: job.lane !== null && OWNER_LANE.test(job.lane) ? job.lane : null };
}
const MAX_SINCE_HOURS = 720;

export interface FleetOrderStateApiDeps {
  /** Reader seam for tests. Default: readOrderTrace(). */
  read?: (opts: { now?: () => number }) => Promise<OrderTraceV1>;
  /** Clock seam for tests; stamps asOf and feeds the classifier. */
  now?: () => Date;
  /** Live-worker reader seam for tests. Default: listLiveWorkers(). Called
   * once per valid GET, after all validation; a throw or an
   * 'unavailable' sourceState leaves RUNNING unproven without failing the
   * request. */
  live?: () => Promise<LiveWorkersSnapshot>;
  /** Lane-targets reader seam for tests. Default: readLaneTargets(). Called
   * once per valid GET, after all validation; a throw or a non-'healthy'
   * sourceState leaves BLOCKED unproven without failing the request. */
  lanes?: () => Promise<LaneTargetsV1>;
  /** Per-reader bound in ms (default VERSE_FLEET_ORDER_STATE_TIMEOUT_MS). */
  timeoutMs?: number;
}

export function createFleetOrderStateApi(deps: FleetOrderStateApiDeps = {}): ApiModule {
  const read = deps.read ?? ((opts) => readOrderTrace(opts));
  const liveRead = deps.live ?? listLiveWorkers;
  const lanesRead = deps.lanes ?? readLaneTargets;
  const timeoutMs = deps.timeoutMs ?? VERSE_FLEET_ORDER_STATE_TIMEOUT_MS;
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
      trace = await bounded(() => read({ now: () => nowMs }), timeoutMs);
    } catch {
      sendJson(res, 200, { v: 1, asOf: nowIso, sources: 'unavailable', orders: [] });
      return true;
    }
    let live: LiveJobIds | undefined;
    let liveState: 'healthy' | 'unavailable';
    try {
      const snapshot = await bounded(liveRead, timeoutMs);
      liveState = snapshot.sourceState;
      if (liveState === 'healthy') live = { jobIds: new Set(snapshot.workers.map((w) => w.job)), at: snapshot.generatedAt };
    } catch {
      liveState = 'unavailable';
    }
    // Lane holds are read once per request, fresh every time — a held or
    // failed snapshot is never cached. A throw or a non-'healthy'
    // sourceState yields no blocker evidence, so BLOCKED is not claimed.
    let lanes: LaneTargetsV1 | undefined;
    try {
      const targets = await bounded(lanesRead, timeoutMs);
      if (targets.sourceState === 'healthy') lanes = targets;
    } catch { /* lanes stays undefined: no blocker evidence */ }
    const lanesState: 'healthy' | 'unavailable' = lanes === undefined ? 'unavailable' : 'healthy';
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
      live: liveState,
      lanes: lanesState,
      orders: orders.slice(0, LIMIT).map((o) => {
        const evidence = orderEvidence(o, trace.generatedAt, live, lanes);
        const c = classifyWorkItem(evidence, nowIso);
        // Owner and pr name the same evidence that produced the state: the
        // claimReceipt job (merged artifact, live running job or fallback
        // claim) and its verified artifact — never a stopped sibling. Only a
        // claim-less order (queued hint or no jobs) still names the most
        // advanced job, and that stays a hint, never a claim.
        const owner = evidence.claimReceipt !== undefined
          ? ownerOf({ id: evidence.claimReceipt, lane: evidence.owner ?? null })
          : ownerOf(mostAdvancedJob(o));
        // `blocker` is the sanitized lane dependency (lanes + held-until
        // timestamp only — never hold reasons or attribution), present on
        // every row only when healthy lane evidence was read.
        const blocker = lanes !== undefined
          ? (c.state === 'BLOCKED' ? heldLaneBlocker(o, lanes)?.dependency ?? null : null)
          : undefined;
        return {
          at: o.at, source: o.source, key: o.key,
          state: c.state, asOf: c.asOf, evidenceSource: c.source,
          missing: c.missing, pr: evidence.verified?.artifact ?? null, owner,
          ...(blocker !== undefined ? { blocker } : {}),
        };
      }),
    }));
    return true;
  };
}

export const handleFleetOrderStateApi: ApiModule = createFleetOrderStateApi();
