/** The `phm throughput` report, one cached read per window and grouping (`--by lane`, `repo` or `tier`). The Throughput pane and Home's Merged PRs card share the 24 hour lane one. */
import type { ThroughputBy, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const THROUGHPUT_WINDOWS = [{ value: '6', label: '6 hours' }, { value: '24', label: '24 hours' }, { value: '168', label: '7 days' }] as const;
export type ThroughputWindow = (typeof THROUGHPUT_WINDOWS)[number]['value'];
export const THROUGHPUT_GROUPS = [{ value: 'lane', label: 'Lanes' }, { value: 'repo', label: 'Repos' }, { value: 'tier', label: 'Tiers' }] as const satisfies ReadonlyArray<{ value: ThroughputBy; label: string }>;
type Windows = Readonly<Record<ThroughputWindow, QueryDef<ThroughputReport>>>;
// The lane reads keep the key they always had, so Home's card and the pane go on sharing one cache entry.
const queryFor = (hours: ThroughputWindow, by: ThroughputBy): QueryDef<ThroughputReport> => ({ key: by === 'lane' ? `fleet-throughput-${hours}` : `fleet-throughput-${hours}-${by}`, fetch: signal => apiGet(`/api/verse/fleet/runs/throughput?hours=${hours}&by=${by}`, signal) });
const windowsOf = (by: ThroughputBy): Windows => ({ 6: queryFor('6', by), 24: queryFor('24', by), 168: queryFor('168', by) });
// One stable definition per window, so switching back reuses the last reading while it refreshes.
export const THROUGHPUT_QUERIES: Windows = windowsOf('lane');
export const THROUGHPUT_GROUP_QUERIES: Readonly<Record<ThroughputBy, Windows>> = { lane: THROUGHPUT_QUERIES, repo: windowsOf('repo'), tier: windowsOf('tier') };
