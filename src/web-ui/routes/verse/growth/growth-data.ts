/**
 * GET /api/verse/growth — the same growth.series.v1 payload as `phm growth --json`.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { GrowthRange, GrowthReport } from '../../../../core/growth/series.js';

export function growthSeriesQuery(range: GrowthRange): QueryDef<GrowthReport> {
  return {
    key: `verse-growth-${range}`,
    fetch: (signal) => apiGet<GrowthReport>(`/api/verse/growth?range=${range}`, signal),
  };
}

/** The range a first visit paints, and the one the shell warm-up reads. */
export const growthSeriesDayQuery = growthSeriesQuery('1D');
