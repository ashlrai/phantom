import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_WINDOW_SCHEMA, type FleetJobWindowV1 } from '../../../../core/fleet/job-window.js';
import { JOB_ID_RE } from './worker-log-model.js';

const STATES = new Set(['running', 'finished-pr', 'finished-empty', 'stopped', 'unknown']);
const text = (v: unknown): boolean => typeof v === 'string';
const textOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

/** Light shape check: enough for the card to render without trusting more than it reads. */
export function isJobWindow(value: unknown): value is FleetJobWindowV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.schema === JOB_WINDOW_SCHEMA && text(v.job) && typeof v.state === 'string' && STATES.has(v.state)
    && text(v.stateLine) && textOrNull(v.reason) && textOrNull(v.prUrl)
    && Array.isArray(v.facts) && v.facts.every(f => typeof f === 'object' && f !== null
      && text((f as Record<string, unknown>).label) && text((f as Record<string, unknown>).value));
}

/**
 * GET /api/fleet/job/window for the card header (one log line: the panes
 * render the tail themselves). Null on 404 and 403: older hubs and the
 * remote gateway do not serve the route, and the card falls back to the
 * `fleet.job.v1` detail.
 */
export function jobWindowQuery(job: string): QueryDef<FleetJobWindowV1 | null> {
  return {
    key: `fleet-job-window:${job}`,
    async fetch(signal) {
      if (!JOB_ID_RE.test(job)) throw new Error('Invalid job ID.');
      try {
        const value = await apiGet<unknown>(`/api/fleet/job/window?id=${encodeURIComponent(job)}&lines=1`, signal);
        if (!isJobWindow(value)) throw new Error('Invalid job window response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },
  };
}
