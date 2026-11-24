import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isJobCost, type FleetJobCostV1 } from './worker-cost-model.js';
import { JOB_ID_RE } from './worker-log-model.js';

export function jobCostQuery(job: string): QueryDef<FleetJobCostV1 | null> {
  return {
    key: `fleet-job-cost:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job/cost?id=${encodeURIComponent(job)}`, signal);
        if (!isJobCost(value)) throw new Error('Invalid job cost response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
        throw error;
      }
    },
  };
}
