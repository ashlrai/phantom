import type { FleetStartStatus } from '../../../../core/fleet/admission-status.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetAdmissionQuery: QueryDef<FleetStartStatus | null> = {
  key: 'verse-fleet-admission',
  async fetch(signal) {
    const report = await apiGet<FleetStartStatus>('/api/verse/fleet/admission', signal);
    return report && ['blocked', 'settling', 'open', 'unknown'].includes(report.state) && typeof report.summary === 'string' ? report : null;
  },
};
