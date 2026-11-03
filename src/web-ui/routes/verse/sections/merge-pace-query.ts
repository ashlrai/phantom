import type { MergePaceReport, MergePaceRow } from '../../../../core/fleet/merge-pace.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const MERGE_PACE_PATH = '/api/verse/fleet/merge-pace';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isRow(value: unknown): value is MergePaceRow {
  return record(value) && typeof value.repo === 'string' && value.repo.length > 0
    && count(value.merges) && count(value.merges_per_hour)
    && (value.median_ttm_s === null || count(value.median_ttm_s));
}

export function isMergePaceReport(value: unknown): value is MergePaceReport {
  return record(value) && value.schema === 'fleet.merge-pace.v1' && value.window_hours === 6
    && typeof value.known === 'boolean'
    && (value.rows === null ? !value.known : value.known && Array.isArray(value.rows) && value.rows.every(isRow));
}

/** The `ashlr fleet merge-pace --json` report; null when the route is not in this build. */
export const mergePaceQuery: QueryDef<MergePaceReport | null> = {
  key: 'verse-fleet-merge-pace',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>(MERGE_PACE_PATH, signal);
      if (!isMergePaceReport(value)) throw new Error('Invalid merge pace response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
