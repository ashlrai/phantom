import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { EmptyJobsReport } from '../../../../core/fleet/empty-jobs.js';
import { FLEET_EMPTY_WHY_REASONS } from '../../../../core/fleet/empty-why-classify.js';
import { EMPTY_WHY_COPY } from './empty-why-copy.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<EmptyJobsReport> = { key: 'empty-jobs', fetch: async signal => {
  const value = await apiGet<EmptyJobsReport>('/api/fleet/empty-jobs', signal);
  if (!value || value.schema !== 'jobs.empty.v1' || !Number.isSafeInteger(value.total) || value.total < 0 ||
    !Array.isArray(value.topCauses) || value.topCauses.some(c => !c || typeof c.label !== 'string' ||
      typeof c.class !== 'string' || typeof c.exampleJob !== 'string' || !Number.isSafeInteger(c.count) || c.count < 0) ||
    (value.reasons != null && (!value.reasons.by_reason || typeof value.reasons.by_reason !== 'object'))) {
    throw new Error('Unsupported empty job observation');
  }
  return value;
} };
export function EmptyJobsPanel() {
  const result = useQuery(query);
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 300_000);
  return <section aria-label="Why jobs came back empty"><h3>Why jobs came back empty</h3>
    {result.status === 'error' ? <p>Job reasons are unavailable.</p> : !result.data ? <p>Loading job reasons…</p> : <>
      <p>{result.data.total} empty jobs in the last 24 hours</p>
      {result.data.topCauses.length ? <ul>{result.data.topCauses.map(cause => <li key={cause.class}>{cause.label}: {cause.count} · Example: {cause.exampleJob}</li>)}</ul> : <p>No empty jobs in this period.</p>}
      {result.data.reasons && <ReasonChips by_reason={result.data.reasons.by_reason} />}
    </>}
  </section>;
}

/** Log-tail reasons, most common first, each with what it means and what to do. */
function ReasonChips({ by_reason }: { by_reason: NonNullable<EmptyJobsReport['reasons']>['by_reason'] }) {
  const present = FLEET_EMPTY_WHY_REASONS.filter(r => by_reason[r] > 0).sort((a, b) => by_reason[b] - by_reason[a]);
  if (present.length === 0) return null;
  return <div aria-label="Why jobs ended empty">
    <p>{present.map(r => `${r} ${by_reason[r]}`).join(' · ')}</p>
    <ul>{present.map(r => <li key={r}><strong>{r}</strong>: {EMPTY_WHY_COPY[r]}</li>)}</ul>
  </div>;
}
