import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { ORDER_STATE_PATH, parseOrderStateBody, type OrderStateParse } from './order-state-model.js';

/**
 * One read of the order-state route. 404, a network error or a malformed body
 * all resolve to `unavailable` — never to an empty order list.
 */
export const orderStateQuery: QueryDef<OrderStateParse> = {
  key: 'verse-fleet-work-board-orders',
  async fetch(signal) {
    try { return parseOrderStateBody(await apiGet<unknown>(ORDER_STATE_PATH, signal)); }
    catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'unavailable' };
    }
  },
};
