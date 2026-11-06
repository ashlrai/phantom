import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { readPendingPhones, type PendingGateway, type PendingPhone } from './pending-phones-model.js';

type PendingSnapshot = { gateway: PendingGateway; approvals: PendingPhone[] } | { kind: 'notInBuild' };
export const pendingPhonesQuery: QueryDef<PendingSnapshot> = {
  key: 'verse-remote-pending',
  async fetch(signal) {
    try {
      const data = await apiGet<unknown>('/api/verse/fleet/control/remote-pending', signal);
      const approvals = readPendingPhones(data);
      if (!approvals) throw new Error('Invalid pending phones response');
      return { gateway: (data as { gateway: PendingGateway }).gateway, approvals };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
