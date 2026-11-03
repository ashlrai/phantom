import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';
import { stateWord, type OrderTraceV1 } from '../../routes/verse/fleet-inbox/order-trace-model.js';
import type { AppNotification } from './types.js';

const WINDOW_MS = 48 * 60 * 60_000;
const DETAIL_JOBS = 3;

/**
 * One info notification per recent order (last 48 h) with at least one merged
 * job. The id is the order key, so later readings update the same entry. Only
 * `stateWord` text reaches the output; job URLs are never copied through.
 */
export function deriveOrderMergedNotifications(trace: OrderTraceV1 | null | undefined, nowMs: number): AppNotification[] {
  if (!trace) return [];
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const actionHref = paneLinkUrl('fleet-inbox', null, false, base) ?? undefined;
  const seen = new Set<string>();
  const out: AppNotification[] = [];
  for (const order of trace.orders) {
    const at = Date.parse(order.at);
    if (!Number.isFinite(at) || nowMs - at > WINDOW_MS || seen.has(order.key)) continue;
    const merged = order.jobs.filter(job => job.state === 'merged').length;
    if (!merged) continue;
    seen.add(order.key);
    const total = order.jobs.length;
    const words = order.jobs.slice(0, DETAIL_JOBS).map(stateWord).join(', ');
    const more = total - DETAIL_JOBS;
    out.push({
      id: `order-merged:${order.key}`, category: 'fleet', severity: 'info',
      title: `Your ${order.key} order: ${merged === total ? `All ${total}` : `${merged} of ${total}`} merged`,
      detail: more > 0 ? `${words} and ${more} more` : words,
      ts: order.at, actionHref, actionLabel: 'Open inbox',
    });
  }
  return out;
}
