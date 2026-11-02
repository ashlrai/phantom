import { apiGet } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';

export interface PhonePendingApproval {
  id: string;
  label: string;
  email?: string;
  deviceType?: string;
}

export const phonePendingQuery: QueryDef<PhonePendingApproval[] | null> = {
  key: 'verse-fleet-remote-pending',
  async fetch(signal) {
    try {
      const reply = await apiGet<unknown>('/api/verse/fleet/control/remote-pending', signal);
      if (!reply || typeof reply !== 'object' || !('approvals' in reply) || !Array.isArray(reply.approvals)) return null;
      return reply.approvals.flatMap((row: unknown): PhonePendingApproval[] => {
        if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string'
          || !('label' in row) || typeof row.label !== 'string') return [];
        return [{ id: row.id, label: row.label,
          email: 'email' in row && typeof row.email === 'string' ? row.email : undefined,
          deviceType: 'deviceType' in row && typeof row.deviceType === 'string' ? row.deviceType : undefined }];
      });
    } catch {
      // An optional endpoint, including 404 and transient read failures, is silent.
      return null;
    }
  },
};
