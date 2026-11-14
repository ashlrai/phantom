/**
 * fleet_order_state — read-only projection of `ashlr fleet order-state --json`
 * over the isolated fleet MCP server, giving MCP-only agents the same order
 * states Mason sees: each inbox order classified RECEIVED / ASSIGNED /
 * RUNNING / BLOCKED / VERIFIED from the real order trace (readOrderTrace)
 * plus one live-worker snapshot (listLiveWorkers), exactly as the verse
 * work-board/orders API does. Evidence only: it grants no claim, dispatch or
 * merge authority, and a queued line names an owner but is not a claim.
 *
 * Each read is time-bounded (8 s per reader). A trace read that throws or
 * times out answers sources 'unavailable' with no orders and no live read; a
 * live read that throws or times out leaves live 'unavailable' and RUNNING
 * unproven. Thrown message text, file paths, order text bodies, command
 * lines and pids never cross this boundary.
 */
import { parseOrderAt } from '../cli/fleet-orders.js';
import { classifyOrder, mostAdvancedJob, type LiveJobIds } from '../core/fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Newest orders kept, matching the CLI and verse API. */
export const FLEET_ORDER_STATE_LIMIT = 20;
/** `sinceHours` upper bound, matching the CLI's --since and the API's ?since. */
export const FLEET_ORDER_STATE_MAX_SINCE_HOURS = 720;
/** Per-reader bound: a hung trace or live read degrades instead of stalling the call. */
export const FLEET_ORDER_STATE_TIMEOUT_MS = 8_000;

export interface FleetOrderStateDeps {
  /** Optional hour window for returned orders: an integer 1..720. Any other
   * value is reported { status: 'invalid' } before either reader runs. */
  sinceHours?: unknown;
  /** Order-trace reader (default readOrderTrace). */
  read?: (opts: { now?: () => number }) => Promise<OrderTraceV1>;
  /** Live-worker snapshot reader (default listLiveWorkers). */
  live?: () => Promise<LiveWorkersSnapshot>;
  /** Clock for asOf and the sinceHours cutoff (default Date.now). */
  now?: () => number;
  /** Per-reader bound in ms (default FLEET_ORDER_STATE_TIMEOUT_MS). */
  timeoutMs?: number;
}

/** The tool's one argument; only the key set is validated server-side. */
export type FleetOrderStateArgs = Pick<FleetOrderStateDeps, 'sinceHours'>;

/** The tool accepts only `sinceHours`; any other key — including a caller
 * root, path or cwd — is rejected before a read is attempted. The value's
 * own range check lives in readFleetOrderState so a bad value is reported
 * { status: 'invalid' } rather than failing the call. */
export function parseFleetOrderStateArgs(args: Record<string, unknown>): FleetOrderStateArgs | null {
  return Object.keys(args).every(key => key === 'sinceHours') ? { sinceHours: args['sinceHours'] } : null;
}

/** Bounded read: a throw or timeout rejects so the caller can degrade. */
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

/** The same JSON the verse API sends: classified order rows newest first,
 * capped at FLEET_ORDER_STATE_LIMIT, through the shared public-JSON scrub. */
export async function readFleetOrderState(deps: FleetOrderStateDeps = {}): Promise<unknown> {
  const { sinceHours } = deps;
  if (sinceHours !== undefined &&
      (typeof sinceHours !== 'number' || !Number.isSafeInteger(sinceHours) ||
        sinceHours < 1 || sinceHours > FLEET_ORDER_STATE_MAX_SINCE_HOURS)) {
    return { status: 'invalid', reason: `sinceHours must be an integer from 1 to ${FLEET_ORDER_STATE_MAX_SINCE_HOURS}.` };
  }
  const read = deps.read ?? ((opts: { now?: () => number }) => readOrderTrace(opts));
  const liveRead = deps.live ?? listLiveWorkers;
  const timeoutMs = deps.timeoutMs ?? FLEET_ORDER_STATE_TIMEOUT_MS;
  const ms = (deps.now ?? Date.now)();
  const nowMs = Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
  const nowIso = new Date(nowMs).toISOString();
  let trace: OrderTraceV1;
  try {
    trace = await bounded(() => read({ now: () => nowMs }), timeoutMs);
  } catch {
    return { v: 1, asOf: nowIso, sources: 'unavailable', live: 'unavailable', orders: [] };
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
  let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
  if (sinceHours !== undefined) {
    const cutoff = nowMs - sinceHours * 3600_000;
    orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= cutoff; });
  }
  return sanitizePublicJson({
    v: 1,
    generatedAt: trace.generatedAt,
    asOf: nowIso,
    sources: trace.sources,
    live: liveState,
    orders: orders.slice(0, FLEET_ORDER_STATE_LIMIT).map((o) => {
      const c = classifyOrder(o, trace.generatedAt, nowIso, live);
      return {
        at: o.at, source: o.source, key: o.key,
        state: c.state, asOf: c.asOf, evidenceSource: c.source,
        missing: c.missing, pr: mostAdvancedJob(o)?.url ?? null,
      };
    }),
  });
}
