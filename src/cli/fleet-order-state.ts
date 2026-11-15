/** `ashlr fleet order-state [--since <hours>] [--json]` — classify each of
 * Mason's inbox orders under the Nov12 22:29 ET reporting contract from the
 * real order trace (readOrderTrace): RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED with as-of, evidence source and missing evidence. RUNNING comes
 * from the live process table (listLiveWorkers): a launched or published job
 * with a live worker proves it. BLOCKED comes from lane holds (readLaneTargets,
 * queue/slots.json): an order whose every job is queued on a held lane names
 * the held lane as its dependency, never the hold reason. Read-only: reads local files and the host
 * process table, no network, no writes; never prints order text bodies,
 * command lines or pids. */
import { heldLaneBlocker } from '../core/fleet/order-lane-blocker.js';
import { classifyOrder, mostAdvancedJob, type LiveJobIds, type TraceOrder } from '../core/fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';
import { readLaneTargets, type LaneTargetsV1 } from '../core/fleet/runs-lane-targets.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';
import { parseOrderAt } from './fleet-orders.js';

const usage = 'Usage: ashlr fleet order-state [--since <hours 1-720>] [--json]';
const LIMIT = 20;

export async function cmdFleetOrderState(
  args: string[],
  deps: {
    read?: typeof readOrderTrace; now?: () => number;
    live?: () => Promise<LiveWorkersSnapshot>; lanes?: () => Promise<LaneTargetsV1>;
  } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false;
  let since: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--since' && since === undefined) {
      const raw = args[++i];
      const hours = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(hours >= 1 && hours <= 720)) { console.error(`fleet order-state: --since needs 1-720 hours\n${usage}`); return 2; }
      since = hours;
    } else { console.error(`fleet order-state: bad argument: ${arg}\n${usage}`); return 2; }
  }
  let trace: OrderTraceV1;
  try {
    trace = await (deps.read ?? readOrderTrace)({ now: deps.now });
  } catch {
    console.error('fleet order-state: unable to read the order trace');
    return 1;
  }
  const nowMs = (deps.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  let live: LiveJobIds | undefined;
  let liveState: 'healthy' | 'unavailable';
  try {
    const snapshot = await (deps.live ?? listLiveWorkers)();
    liveState = snapshot.sourceState;
    if (liveState === 'healthy') live = { jobIds: new Set(snapshot.workers.map((w) => w.job)), at: snapshot.generatedAt };
  } catch {
    liveState = 'unavailable';
  }
  // Lane holds are read once per run. A throw or a non-healthy slots.json
  // yields no blocker evidence, so BLOCKED is simply not claimed.
  let lanes: LaneTargetsV1 | undefined;
  try {
    const targets = await (deps.lanes ?? readLaneTargets)();
    if (targets.sourceState === 'healthy') lanes = targets;
  } catch { /* lanes stays undefined: no blocker evidence */ }
  const lanesState: 'healthy' | 'unavailable' = lanes === undefined ? 'unavailable' : 'healthy';
  const classify = (o: TraceOrder) => {
    const c = classifyOrder(o, trace.generatedAt, nowIso, live, lanes);
    return { c, blocker: c.state === 'BLOCKED' ? heldLaneBlocker(o, lanes)?.dependency ?? null : null };
  };
  let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
  if (since !== undefined) {
    orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= nowMs - since! * 3600_000; });
  }
  orders = orders.slice(0, LIMIT);
  if (json) {
    console.log(JSON.stringify({
      v: 1, generatedAt: trace.generatedAt, sources: trace.sources, live: liveState, lanes: lanesState,
      orders: orders.map((o) => {
        const { c, blocker } = classify(o);
        return {
          at: o.at, source: o.source, key: o.key,
          state: c.state, asOf: c.asOf, evidenceSource: c.source,
          missing: c.missing, blocker, pr: mostAdvancedJob(o)?.url ?? null,
        };
      }),
    }));
    return 0;
  }
  const bad = Object.entries(trace.sources).filter(([, s]) => s !== 'healthy');
  if (bad.length) console.log(`warning: order sources not healthy: ${bad.map(([k, s]) => `${k}=${s}`).join(' ')}`);
  if (liveState === 'unavailable') console.log('warning: live workers unavailable; RUNNING not checked');
  // stderr, not stdout: hosts without a dispatcher have no slots.json, and the
  // contract lines on stdout stay one-per-order for scripts reading them.
  if (lanesState === 'unavailable') console.error('warning: lane holds unavailable; BLOCKED not checked');
  for (const o of orders) {
    const { c, blocker } = classify(o);
    const url = mostAdvancedJob(o)?.url;
    console.log(`${o.at} ${o.source} ${c.state} as-of=${c.asOf} source=${c.source} missing=${c.missing.length ? c.missing.join(',') : 'none'}${blocker ? ` blocked-on=${blocker}` : ''}${url ? ` pr=${url}` : ''}`);
  }
  return 0;
}
