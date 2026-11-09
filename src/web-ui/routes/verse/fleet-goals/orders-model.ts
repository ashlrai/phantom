// Pure, browser-safe view model for the owner's orders (intent ledger) card.
import type { OrderRow, OrdersViewV1 } from '../../../../core/verse/fleet-orders-view.js';

export type OrdersState = 'unavailable' | 'empty' | 'ready';

export interface OrdersCardModel {
  state: OrdersState;
  headline: string;
  rows: Array<{ id: string; title: string; status: string; quiet: boolean; rq: string; prs: string }>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ordersPrText(pr: OrderRow['prs'][number]): string {
  return `${pr.repo.split('/').pop() ?? pr.repo}#${pr.number}`;
}

export function buildOrdersModel(view: OrdersViewV1): OrdersCardModel {
  const { summary } = view;
  // Anything that is not a well-formed view is treated as unavailable, never as zero orders.
  if (!summary || !Array.isArray(view.items)) return { state: 'unavailable', headline: '', rows: [] };
  if (summary.sourceQuality === 'unavailable') return { state: 'unavailable', headline: '', rows: [] };
  if (summary.sourceQuality === 'missing' || summary.items === 0) return { state: 'empty', headline: '', rows: [] };
  const headline = [plural(summary.items, 'order'), `${summary.shipped} shipped`, `${summary.verified} verified`, `${summary.stale} gone quiet`].join(' · ');
  // The server already orders stale-first; keep that order and only mark.
  const rows = view.items.map(row => ({
    id: row.id,
    title: row.title,
    status: row.status,
    quiet: row.stale,
    rq: row.rq.join(', '),
    prs: row.prs.map(ordersPrText).join(', '),
  }));
  return { state: 'ready', headline, rows };
}
