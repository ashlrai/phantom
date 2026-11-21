/** The `phm throughput` report by lane, one cached read per window. The Throughput pane and Home's Merged PRs card share the 24 hour one. */
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const THROUGHPUT_WINDOWS = [{ value: '6', label: '6 hours' }, { value: '24', label: '24 hours' }, { value: '168', label: '7 days' }] as const;
export type ThroughputWindow = (typeof THROUGHPUT_WINDOWS)[number]['value'];
const queryFor = (hours: ThroughputWindow): QueryDef<ThroughputReport> => ({ key: `fleet-throughput-${hours}`, fetch: signal => apiGet(`/api/verse/fleet/runs/throughput?hours=${hours}&by=lane`, signal) });
// One stable definition per window, so switching back reuses the last reading while it refreshes.
export const THROUGHPUT_QUERIES: Readonly<Record<ThroughputWindow, QueryDef<ThroughputReport>>> = { 6: queryFor('6'), 24: queryFor('24'), 168: queryFor('168') };
