import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { EmptyJobsReport } from '../../../../core/fleet/empty-jobs.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<EmptyJobsReport> = { key: 'empty-jobs', fetch: signal => apiGet<EmptyJobsReport>('/api/fleet/empty-jobs', signal) };
export function EmptyJobsPanel() {
  const result = useQuery(query);
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 300_000);
  return <section aria-label="Why jobs came back empty"><h3>Why jobs came back empty</h3>
    {result.status === 'error' ? <p>Job reasons are unavailable.</p> : !result.data ? <p>Loading job reasons…</p> : <>
      <p>{result.data.total} empty jobs in the last 24 hours</p>
      {result.data.topCauses.length ? <ul>{result.data.topCauses.map(cause => <li key={cause.class}>{cause.label}: {cause.count} · Example: {cause.exampleJob}</li>)}</ul> : <p>No empty jobs in this period.</p>}
    </>}
  </section>;
}
