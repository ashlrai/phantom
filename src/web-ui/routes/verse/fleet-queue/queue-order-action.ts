import {
  VERSE_FLEET_QUEUE_ORDER_PATH, isQueueAction, isQueueOrder,
  type QueueActionV1, type QueueOrderAction, type QueueOrderV1,
} from '../../../../core/queue/order-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

/**
 * The launch-order list and its Top, Lane and Drop actions. Both go through
 * GET/POST /api/verse/fleet/queue/order, the calls behind `phm queue` and
 * `phm queue top|lane|drop`; the server side is core/queue/order.ts.
 */
export const QUEUE_ORDER_PATH = VERSE_FLEET_QUEUE_ORDER_PATH;

/** null when this server has no launch-order route or no queue: the list is then left out. */
export const queueOrderQuery: QueryDef<QueueOrderV1 | null> = {
  key: 'verse-fleet-queue-order',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(QUEUE_ORDER_PATH, signal);
      return isQueueOrder(value) ? value : null;
    } catch (error) {
      if (error instanceof ApiError) return null;
      throw error;
    }
  },
};

export async function postQueueAction(action: QueueOrderAction, id: string, lane?: string): Promise<QueueActionV1> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const report = await apiPost<unknown>(QUEUE_ORDER_PATH, lane === undefined ? { action, id } : { action, id, lane }, token);
  if (!isQueueAction(report)) throw new ApiError('Invalid queue response.', 502, QUEUE_ORDER_PATH, 'The server returned an invalid queue response.');
  touchMutationHold();
  return report;
}
