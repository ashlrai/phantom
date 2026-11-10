import type { LaunchStallViewV1 } from '../../../../core/verse/fleet-launch-stall-api.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const LAUNCH_STALL_PATH = '/api/verse/fleet/control/launch-stall';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const minutes = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function isStall(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || typeof value.stalled !== 'boolean' || !minutes(value.min)) return false;
  if (value.startTime === null) return value.minutes === null && value.lastQ === null && value.lastReap === null && !value.stalled;
  return text(value.startTime) && minutes(value.minutes) && count(value.lastQ) && count(value.lastReap);
}

export function isLaunchStallViewV1(value: unknown): value is LaunchStallViewV1 {
  if (!record(value) || value.v !== 1 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))
    || (value.source !== 'ok' && value.source !== 'unavailable') || !isStall(value.stall) || !Array.isArray(value.lanes)) return false;
  return value.lanes.every((lane: unknown) => record(lane) && text(lane.lane) && Array.isArray(lane.jobs) && lane.jobs.length > 0
    && lane.jobs.every((job: unknown) => record(job) && text(job.job) && minutes(job.ageMinutes)));
}

/** Dispatcher launch stall and stuck lanes; null when the route has not landed in this build. */
export const launchStallQuery: QueryDef<LaunchStallViewV1 | null> = {
  key: 'verse-fleet-launch-stall',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(LAUNCH_STALL_PATH, signal);
      if (!isLaunchStallViewV1(value)) throw new Error('Invalid launch stall response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
