/**
 * Owner-facing projection of the intent ledger for the desktop Goals pane.
 * Read-only. Exposes only id, a capped title, status, RQ keys, PR refs and
 * timing; never evidence notes, provenance sources or paths.
 */
import { listIntents } from '../intent/read.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../intent/schema.js';
import { isStale, summarize, type IntentSummary } from '../intent/summary.js';

export const ORDERS_MAX_ITEMS = 50;
export const ORDERS_MAX_TITLE = 200;

export interface OrderRow {
  id: string;
  title: string;
  status: IntentStatus;
  rq: string[];
  prs: Array<{ repo: string; number: number; state: 'open' | 'merged' | 'closed' | 'unknown' }>;
  lastTouchedAt: string;
  stale: boolean;
}

export interface OrdersViewV1 {
  v: 1;
  observedAt: string;
  summary: IntentSummary;
  items: OrderRow[];
}

const OPEN = new Set<IntentStatus>(['proposed', 'queued', 'in-progress', 'unknown']);

function group(row: OrderRow): number {
  if (row.stale) return 0;
  if (OPEN.has(row.status)) return 1;
  return row.status === 'merged' ? 2 : 3;
}

function touched(row: OrderRow): number {
  const at = Date.parse(row.lastTouchedAt);
  return Number.isFinite(at) ? at : 0;
}

export function toOrderRow(item: IntentItem, nowMs: number): OrderRow {
  return {
    id: item.id,
    title: item.title.slice(0, ORDERS_MAX_TITLE),
    status: item.status,
    rq: [...item.rq],
    prs: item.prs.map(({ repo, number, state }) => ({ repo, number, state })),
    lastTouchedAt: item.lastTouchedAt,
    stale: isStale(item, nowMs),
  };
}

export async function readOrdersView(opts: { root?: string; nowMs?: number } = {}): Promise<OrdersViewV1> {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  try {
    const { items, summary } = await listIntents({ ...opts, nowMs });
    const rows = items.map(item => toOrderRow(item, nowMs))
      .sort((a, b) => group(a) - group(b) || touched(b) - touched(a))
      .slice(0, ORDERS_MAX_ITEMS);
    // The summary's staleItems carry titles too; cap them like the rows.
    const staleItems = summary.staleItems.map(row => ({ ...row, title: row.title.slice(0, ORDERS_MAX_TITLE) }));
    return { v: 1, observedAt, summary: { ...summary, staleItems }, items: rows };
  } catch {
    // A failed read is never reported as zero orders.
    const summary: IntentSummary = { ...summarize(emptyLedger(), nowMs, false), sourceQuality: 'unavailable', countQuality: 'unknown' };
    return { v: 1, observedAt, summary, items: [] };
  }
}
