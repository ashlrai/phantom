import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { ORDER_STATE_PATH, parseOrderStateBody, type OrderStateParse } from './order-state-model.js';
import { orderStripHealth, type OrderStripHealth } from './order-state-health.js';

/** Parsed body plus the live/sources health read from the same raw body. */
export type OrderStateResult = OrderStateParse & { health?: OrderStripHealth };

/**
 * One read of the order-state route. 404, a network error or a malformed body
 * all resolve to `unavailable` — never to an empty order list.
 */
export const orderStateQuery: QueryDef<OrderStateResult> = {
  key: 'verse-fleet-work-board-orders',
  async fetch(signal) {
    try {
      const raw = await apiGet<unknown>(ORDER_STATE_PATH, signal);
      const parsed = parseOrderStateBody(raw);
      return parsed.kind === 'ok' ? { ...parsed, health: orderStripHealth(raw) } : parsed;
    }
    catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'unavailable' };
    }
  },
};
