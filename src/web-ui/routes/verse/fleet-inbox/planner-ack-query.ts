import { apiGet, ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import type { PlannerAck } from './planner-ack-model.js';

interface PlannerAcks { v: 1; generatedAt: string; available: boolean; acks: PlannerAck[] }
export const plannerAckQuery: QueryDef<PlannerAcks | null> = {
  key: 'verse-fleet-inbox-acks',
  fetch: async signal => {
    try { return await apiGet<PlannerAcks>('/api/verse/fleet/inbox/acks', signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
export function usePlannerAcks(visible: boolean) {
  const query = useQuery(plannerAckQuery);
  const refresh = useRefetch(plannerAckQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible && query?.data !== null });
  return query?.data?.acks;
}
