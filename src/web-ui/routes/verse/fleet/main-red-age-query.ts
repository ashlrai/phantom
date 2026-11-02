import type { MainRedAgeV1, RedAgeRow } from '../../../../core/fleet/main-red-age.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const MAIN_RED_AGE_PATH = '/api/verse/fleet/main-red-age';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const nullableCount = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

export function isRedAgeRow(value: unknown): value is RedAgeRow {
  return record(value) && typeof value.repo === 'string' && value.repo.length > 0
    && (value.state === 'green' || value.state === 'red' || value.state === 'unknown')
    && nullableString(value.redSince) && nullableCount(value.redMinutes)
    && nullableCount(value.attempts) && nullableString(value.currentJob);
}

export function isMainRedAgeV1(value: unknown): value is MainRedAgeV1 {
  return record(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && typeof value.known === 'boolean'
    && Array.isArray(value.repos) && value.repos.every(isRedAgeRow);
}

/** Guardian per-repo main state; null when the route has not landed in this build. */
export const mainRedAgeQuery: QueryDef<MainRedAgeV1 | null> = {
  key: 'verse-fleet-main-red-age',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(MAIN_RED_AGE_PATH, signal);
      if (!isMainRedAgeV1(value)) throw new Error('Invalid main red-age response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
