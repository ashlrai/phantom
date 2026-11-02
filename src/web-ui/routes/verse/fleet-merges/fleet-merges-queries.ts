import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { CiRunFactsV1 } from './merges-ci-verdict.js';

export const fleetMergesQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs', signal),
};

export const outsidePrsQuery: QueryDef<unknown> = {
  key: 'verse-fleet-outside-prs',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/live/outside-prs', signal),
};

export const ciRunsQuery: QueryDef<CiRunFactsV1> = {
  key: 'verse-fleet-ci-runs-24h',
  fetch: signal => apiGet<CiRunFactsV1>('/api/verse/fleet/ci-runs?hours=24', signal),
};

export const supersededQuery: QueryDef<unknown> = {
  key: 'verse-fleet-superseded',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runs/superseded', signal),
};
