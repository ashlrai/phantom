import type { SkippedJobsV1 } from '../../../../core/fleet/skipped-jobs.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<SkippedJobsV1> = { key: 'fleet-skipped', fetch: signal => apiGet('/api/verse/fleet/runs/skipped', signal) };

/** "Skipped: N" for the last 24 hours, opening the same list as `phm jobs skipped`. Read-only. */
export function SkippedCard({ visible }: { visible: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const data = read.data;
  if (!data || typeof data.total !== 'number') return <p>Skipped: {read.status === 'error' ? 'unknown' : 'reading…'}</p>;
  if (!data.known) return <p>Skipped: unknown. The jobs ledger could not be read.</p>;
  if (data.total === 0) return <p>Skipped: 0. No jobs were skipped in the last 24 hours.</p>;
  return <details aria-label="Skipped jobs">
    <summary>Skipped: {data.total} in the last 24 hours</summary>
    <p>The dispatcher dropped these jobs before launch. Same list: <code>phm jobs skipped</code>.</p>
    {data.repeated.length ? <p>Skipped more than once: {data.repeated.join(', ')}</p> : null}
    {data.by_code.map(group => <section key={String(group.code)}>
      <h4>Code {group.code ?? 'unknown'}: {group.meaning} ({group.count})</h4>
      <ul>{group.jobs.map((job, i) => <li key={`${job.job}:${job.at}:${i}`}>{job.job} · {job.lane} · {job.repo} · {job.at}{job.leader ? ' · leader' : ''}</li>)}</ul>
    </section>)}
    <h4>By job family</h4>
    <ul>{data.by_family.map(f => <li key={f.family}>{f.family}: {f.count}</li>)}</ul>
  </details>;
}
