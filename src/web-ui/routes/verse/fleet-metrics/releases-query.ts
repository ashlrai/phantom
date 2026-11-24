import type { ReleasesReport } from '../../../../core/release/status.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** The `phm releases --json` report. One key, so the desktop card and the phone card share a read. */
export const releasesQuery: QueryDef<ReleasesReport> = { key: 'fleet-releases', fetch: signal => apiGet('/api/fleet/releases', signal) };
