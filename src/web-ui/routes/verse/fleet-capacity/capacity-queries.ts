import type { RunsHistory } from '../../../../core/fleet/runs-history.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function isRunsHistory(value: unknown): value is RunsHistory {
  if (!record(value) || value.v !== 1 || !date(value.generatedAt) || !date(value.from) || !date(value.to)
    || (value.sourceState !== 'healthy' && value.sourceState !== 'missing' && value.sourceState !== 'degraded') || !count(value.dropped) || !Array.isArray(value.samples)) return false;
  return value.samples.every((sample: unknown) => record(sample) && date(sample.at) && Array.isArray(sample.lanes)
    && (sample.workers === null || count(sample.workers)) && (sample.leaders === null || count(sample.leaders))
    && (sample.paused === null || typeof sample.paused === 'boolean')
    && sample.lanes.every((lane: unknown) => record(lane) && typeof lane.lane === 'string' && lane.lane.length > 0
      && count(lane.running) && count(lane.target) && count(lane.queued) && typeof lane.held === 'boolean'));
}

export type CapacityHours = 6 | 24 | 72;
export function runsHistoryQuery(hours: CapacityHours = 24): QueryDef<RunsHistory | null> {
  return {
    key: hours === 24 ? 'verse-runs-history' : `verse-runs-history:${hours}`,
    async fetch(signal) {
      try {
        const value = await apiGet<unknown>(`/api/verse/runs-history?hours=${hours}`, signal);
        if (!isRunsHistory(value)) throw new Error('Invalid capacity history response.');
        return value;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
