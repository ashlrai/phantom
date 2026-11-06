import type { FleetJobTextV1 } from '../../../../core/fleet/runs-job-texts.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from './worker-log-model.js';

function isJobText(value: unknown, job: string, kind: FleetJobTextV1['kind']): value is FleetJobTextV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<FleetJobTextV1>;
  return v.v === 1 && v.job === job && v.kind === kind
    && (v.state === 'ok' || v.state === 'missing' || v.state === 'unreadable')
    && (v.bytes === null || (typeof v.bytes === 'number' && Number.isSafeInteger(v.bytes) && v.bytes >= 0))
    && typeof v.truncated === 'boolean' && typeof v.text === 'string';
}

export function jobTextQuery(job: string, kind: FleetJobTextV1['kind']): QueryDef<FleetJobTextV1 | null> {
  return {
    key: `fleet-job-text:${kind}:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job/text?id=${encodeURIComponent(job)}&kind=${kind}`, signal);
        if (!isJobText(value, job, kind)) throw new Error('Invalid job text response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
