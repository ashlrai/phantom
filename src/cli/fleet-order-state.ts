/** `ashlr fleet order-state [--since <hours>] [--json]` — classify each of
 * Mason's inbox orders under the Nov12 22:29 ET reporting contract from the
 * real order trace (readOrderTrace): RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED with as-of, evidence source and missing evidence. Read-only:
 * reads local files, no network, no writes; never prints order text bodies. */
import { classifyOrder, mostAdvancedJob } from '../core/fleet/order-work-state.js';
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';
import { parseOrderAt } from './fleet-orders.js';

const usage = 'Usage: ashlr fleet order-state [--since <hours 1-720>] [--json]';
const LIMIT = 20;

export async function cmdFleetOrderState(
  args: string[],
  deps: { read?: typeof readOrderTrace; now?: () => number } = {},
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
  let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
  if (since !== undefined) {
    orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= nowMs - since! * 3600_000; });
  }
  orders = orders.slice(0, LIMIT);
  if (json) {
    console.log(JSON.stringify({
      v: 1, generatedAt: trace.generatedAt, sources: trace.sources,
      orders: orders.map((o) => {
        const c = classifyOrder(o, trace.generatedAt, nowIso);
        return {
          at: o.at, source: o.source, key: o.key,
          state: c.state, asOf: c.asOf, evidenceSource: c.source,
          missing: c.missing, pr: mostAdvancedJob(o)?.url ?? null,
        };
      }),
    }));
    return 0;
  }
  const bad = Object.entries(trace.sources).filter(([, s]) => s !== 'healthy');
  if (bad.length) console.log(`warning: order sources not healthy: ${bad.map(([k, s]) => `${k}=${s}`).join(' ')}`);
  for (const o of orders) {
    const c = classifyOrder(o, trace.generatedAt, nowIso);
    const url = mostAdvancedJob(o)?.url;
    console.log(`${o.at} ${o.source} ${c.state} as-of=${c.asOf} source=${c.source} missing=${c.missing.length ? c.missing.join(',') : 'none'}${url ? ` pr=${url}` : ''}`);
  }
  return 0;
}
