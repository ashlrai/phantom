import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { EmptyJobsReport } from '../../../../core/fleet/empty-jobs.js';
import { FLEET_EMPTY_WHY_REASONS } from '../../../../core/fleet/empty-why-classify.js';
import { EMPTY_WHY_COPY } from './empty-why-copy.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<EmptyJobsReport> = { key: 'empty-jobs', fetch: signal => apiGet<EmptyJobsReport>('/api/fleet/empty-jobs', signal) };
const labels = { 'already-done': 'Already done', 'blocked-by-env': 'Environment blocked', 'missing-input': 'Missing input', 'scope-too-cautious': 'Scope or approval', other: 'Other' } as const;
export function EmptyJobsPanel() {
  const result = useQuery(query);
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 300_000);
  return <section aria-label="Empty jobs"><h3>Empty jobs · last 24 hours</h3>
    {result.status === 'error' ? <p>Job reasons are unavailable.</p> : !result.data ? <p>Loading job reasons…</p> : <>
      <p>{result.data.total} empty jobs</p>
      <ul>{(Object.keys(labels) as Array<keyof typeof labels>).map(key => <li key={key}>{labels[key]}: {result.data!.counts[key]}</li>)}</ul>
      {result.data.reasons && <ReasonChips by_reason={result.data.reasons.by_reason} />}
    </>}
  </section>;
}

function ReasonChips({ by_reason }: { by_reason: NonNullable<EmptyJobsReport['reasons']>['by_reason'] }) {
  const present = FLEET_EMPTY_WHY_REASONS.filter(r => by_reason[r] > 0).sort((a, b) => by_reason[b] - by_reason[a]);
  if (present.length === 0) return null;
  return <div aria-label="Why jobs ended empty">
    <p>{present.map(r => `${r} ${by_reason[r]}`).join(' · ')}</p>
    <ul>{present.map(r => <li key={r}><strong>{r}</strong>: {EMPTY_WHY_COPY[r]}</li>)}</ul>
  </div>;
}
