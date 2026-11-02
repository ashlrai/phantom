import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isJobChanges, type FleetJobChangesV1 } from './worker-changes-model.js';
import { JOB_ID_RE } from './worker-log-model.js';

export function jobChangesQuery(job: string): QueryDef<FleetJobChangesV1 | null> {
  return {
    key: `fleet-job-changes:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job/changes?id=${encodeURIComponent(job)}`, signal);
        if (!isJobChanges(value)) throw new Error('Invalid job changes response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
        throw error;
      }
    },
  };
}
