/**
 * core/fleet/recheck-orders-line.ts: the one "Orders 24h:" evidence line of
 * the paste-ready fleet recheck thread reply (see fleet-recheck-reply.ts).
 * It answers "how do Mason's own orders stand" — the count of his last-24h
 * inbox orders in each work state under the Nov 12 22:29 ET reporting
 * contract (see order-work-state.ts), never the orders' text.
 *
 * summarizeOrders is pure: no I/O, no clock reads — the caller passes
 * `nowIso` and the already-read order trace. The classification stays cheap:
 * no live-worker or queue arguments, so RUNNING is only reported when the
 * trace's own evidence reaches it. formatOrdersLine is pure too; every
 * interpolated string goes through the caller's scrub, so the reply's
 * redaction rules (IPs, home paths, banned verbs) apply here as well.
 *
 * The line is evidence, not a claim: it never changes a section state, the
 * overall verdict, the task pick or missing[]. A read whose order source
 * could not report proves neither counts nor "none", so the line is omitted
 * (null) rather than overstating the evidence; a reader that failed outright
 * is still named as "unknown (reader failed)".
 */
import { parseOrderAt } from '../../cli/fleet-orders.js';
import type { WorkItemState } from '../comms/work-item-state.js';
import { classifyOrder } from './order-work-state.js';
import type { OrderTraceV1 } from './order-trace.js';

/** The reporting contract's look-back for "recent" inbox orders, in ms. */
const WINDOW_MS = 24 * 3_600_000;
/** States are named only when their count is above zero, in this order. */
const STATE_ORDER: readonly WorkItemState[] = ['VERIFIED', 'RUNNING', 'BLOCKED', 'ASSIGNED', 'RECEIVED'];
/** The reader-failure marker readFleetRecheck writes into reasons[]. */
const READER_FAILED = 'orders: reader failed';
/** Whole-line budget; reasons are truncated to fit, counts never are. */
const LINE_MAX = 240;
const NO_ORDERS = 'Orders 24h: none';

/** The verdict's orders evidence: how many of Mason's last-24h inbox orders
 * classify into each work state, plus one reason per unhealthy trace source. */
export interface RecheckOrders {
  /** The trace's own generation time, not the verdict clock. */
  asOf: string;
  windowHours: 24;
  counts: Partial<Record<WorkItemState, number>>;
  total: number;
  reasons: string[];
}

/** Count the trace's last-24h orders by work state. An order whose `at`
 * cannot be parsed as Eastern wall time, or that is older than the window,
 * is skipped; every other order is classified from the trace alone. */
export function summarizeOrders(trace: OrderTraceV1, nowIso: string): RecheckOrders {
  const generatedAt = typeof trace?.generatedAt === 'string' ? trace.generatedAt : nowIso;
  const nowMs = Date.parse(nowIso);
  const cutoff = nowMs - WINDOW_MS;
  const counts: Partial<Record<WorkItemState, number>> = {};
  let total = 0;
  for (const order of trace?.orders ?? []) {
    const at = parseOrderAt(order.at);
    if (at === null || !Number.isFinite(nowMs) || at < cutoff) continue;
    const { state } = classifyOrder(order, generatedAt, nowIso);
    counts[state] = (counts[state] ?? 0) + 1;
    total += 1;
  }
  const reasons: string[] = [];
  for (const [source, state] of Object.entries(trace?.sources ?? {})) {
    if (state !== 'healthy') reasons.push(`orders: ${source} ${state}`);
  }
  return { asOf: generatedAt, windowHours: 24, counts, total, reasons };
}

/** Format the orders evidence as one reply line. Returns null when the
 * evidence cannot say anything honest: the field is absent, or nothing was
 * counted while the order source (inbox) itself could not be read — "none"
 * is only asserted when the trace could actually list the orders. */
export function formatOrdersLine(
  o: RecheckOrders | null | undefined,
  scrub: (s: string) => string,
): string | null {
  if (o === null || o === undefined) return null;
  const reasons = Array.isArray(o.reasons) ? o.reasons.filter(r => typeof r === 'string' && r !== '') : [];
  if (reasons.includes(READER_FAILED)) return 'Orders 24h: unknown (reader failed)';
  const counts = STATE_ORDER
    .filter(state => (o.counts?.[state] ?? 0) > 0)
    .map(state => `${o.counts[state]} ${state}`);
  const head = counts.length === 0 ? NO_ORDERS : `Orders 24h: ${counts.join(', ')}`;
  const tail = ` · as of ${scrub(String(o.asOf))} (order-trace)`;
  const room = Math.max(0, LINE_MAX - head.length - tail.length - 3);
  const reason = reasons.length === 0 ? '' : ` · ${scrub(reasons.join('; ')).slice(0, room)}`;
  if (counts.length === 0) {
    if (reasons.some(r => r.startsWith('orders: inbox '))) return null;
    return `${head}${reason}${reason === '' ? '' : tail}`;
  }
  return `${head}${reason}${tail}`;
}
