import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isJobDetail, JOB_ID_RE, type FleetJobDetailV1 } from './worker-log-model.js';

export function jobDetailQuery(job: string): QueryDef<FleetJobDetailV1 | null> {
  return {
    key: `fleet-job:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job?id=${encodeURIComponent(job)}`, signal);
        if (!isJobDetail(value)) throw new Error('Invalid job detail response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
