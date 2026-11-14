import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isJobActivity, type JobActivityV1 } from './job-activity-model.js';
import { JOB_ID_RE } from './worker-log-model.js';

export function jobActivityQuery(job: string): QueryDef<JobActivityV1 | null> {
  return {
    key: `fleet-job-activity:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job/activity?id=${encodeURIComponent(job)}`, signal);
        if (!isJobActivity(value)) throw new Error('Invalid job activity response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 503)) return null;
        throw error;
      }
    },
  };
}
