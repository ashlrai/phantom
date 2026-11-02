/**
 * `ashlr fleet orders [--uncovered] [--since <hours>] [--json]` — read-only
 * view of Mason's inbox orders and the jobs serving each (readOrderTrace), so
 * planners can see which orders have no job. Never prints order text bodies.
 */
import { readOrderTrace, type OrderTraceV1 } from '../core/fleet/order-trace.js';

const usage = 'Usage: ashlr fleet orders [--uncovered] [--since <hours 1-720>] [--json]';
const LIMIT = 20;
const zone = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

function zoneOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(zone.formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(utcMs / 60000) * 60000;
}

/** Parse "YYYY-MM-DD HH:MM[ ET]" as America/New_York wall time; null when unparsable. */
export function parseOrderAt(at: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) ([0-2]\d):([0-5]\d)(?: ET)?$/.exec(at);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wall).getUTCMonth() !== mo - 1) return null;
  // Two passes settle the offset across DST boundaries.
  const first = wall - zoneOffsetMs(wall);
  return wall - zoneOffsetMs(first);
}

function counts(jobs: OrderTraceV1['orders'][number]['jobs']): string {
  const n = (state: string): number => jobs.filter((j) => j.state === state).length;
  return `jobs=${jobs.length} queued=${n('queued')} launched=${n('launched')} published=${n('published')}`;
}

export async function cmdFleetOrders(
  args: string[],
  deps: { read?: typeof readOrderTrace; now?: () => number } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false;
  let uncovered = false;
  let since: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--uncovered') uncovered = true;
    else if (arg === '--since' && since === undefined) {
      const raw = args[++i];
      const hours = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(hours >= 1 && hours <= 720)) { console.error(`fleet orders: --since needs 1-720 hours\n${usage}`); return 2; }
      since = hours;
    } else { console.error(`fleet orders: bad argument: ${arg}\n${usage}`); return 2; }
  }
  let trace: OrderTraceV1;
  try {
    trace = await (deps.read ?? readOrderTrace)({ now: deps.now });
  } catch {
    console.error('fleet orders: unable to read the order trace');
    return 1;
  }
  const nowMs = (deps.now ?? Date.now)();
  let orders = [...trace.orders].sort((a, b) => b.at.localeCompare(a.at));
  if (since !== undefined) {
    orders = orders.filter((o) => { const t = parseOrderAt(o.at); return t !== null && t >= nowMs - since! * 3600_000; });
  }
  if (uncovered) orders = orders.filter((o) => o.jobs.length === 0);
  orders = orders.slice(0, LIMIT);
  if (json) {
    console.log(JSON.stringify({
      v: 1, generatedAt: trace.generatedAt, sources: trace.sources,
      orders: orders.map((o) => ({
        at: o.at, source: o.source, key: o.key, uncovered: o.jobs.length === 0,
        jobs: o.jobs.map((j) => ({ id: j.id, lane: j.lane, state: j.state, url: j.url })),
      })),
    }));
    return 0;
  }
  const bad = Object.entries(trace.sources).filter(([, s]) => s !== 'healthy');
  if (bad.length) console.log(`warning: order sources not healthy: ${bad.map(([k, s]) => `${k}=${s}`).join(' ')}`);
  for (const o of orders) console.log(`${o.at} ${o.source} ${counts(o.jobs)}${o.jobs.length ? '' : ' UNCOVERED'}`);
  return 0;
}
