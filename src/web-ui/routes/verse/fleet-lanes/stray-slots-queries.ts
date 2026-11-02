import type { StraySlotsV1 } from '../../../../core/fleet/stray-slots.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const STRAY_SLOTS_PATH = '/api/verse/fleet/control/stray-slots';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function isStraySlotsV1(value: unknown): value is StraySlotsV1 {
  if (!record(value) || value.v !== 1 || !date(value.generatedAt)
    || (value.source !== 'ok' && value.source !== 'unavailable') || !Array.isArray(value.lanes)) return false;
  return value.lanes.every((lane: unknown) => record(lane) && typeof lane.lane === 'string' && lane.lane.length > 0
    && count(lane.slotsLost) && Array.isArray(lane.strays)
    && lane.strays.every((stray: unknown) => record(stray) && typeof stray.job === 'string' && stray.job.length > 0
      && count(stray.pid) && stray.pid > 0 && (stray.ageSeconds === null || count(stray.ageSeconds))));
}

/** Host stray-slot evidence; null when the route has not landed in this build. */
export const straySlotsQuery: QueryDef<StraySlotsV1 | null> = {
  key: 'verse-fleet-stray-slots',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(STRAY_SLOTS_PATH, signal);
      if (!isStraySlotsV1(value)) throw new Error('Invalid stray slots response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
