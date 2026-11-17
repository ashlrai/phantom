/** Home Releases card: built only on GET /api/verse/fleet/runs/releases, the same report as `phm releases --json`.
 * It names what needs doing first; the one action re-reads the local refs. Nothing here tags or releases. */
import { narrowReleases, releasesHomeField, type ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { Card, Value } from './home-card.js';

export const releasesQuery: QueryDef<ReleasesV1> = { key: 'fleet-releases', fetch: signal => apiGet('/api/verse/fleet/runs/releases', signal) };

export function ReleasesCard({ visible }: { visible: boolean }) {
  const read = useQuery(releasesQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(releasesQuery);
  // Release state moves slowly; one read every ten minutes is plenty.
  usePollWhileVisible(refresh, 600_000, { enabled: visible });
  const report = narrowReleases(read.data);
  const pending = !report && read.status !== 'error' && !read.data;
  const attention = report?.repos.filter(row => row.next !== 'nothing to release') ?? [];
  return <Card title="Releases" action="Check again" onOpen={refresh}>
    {pending ? <p>Reading releases…</p> : <Value field={releasesHomeField(report)}>{summary => <>
      <p>{summary.headline}</p>
      {attention.length ? <ul>{attention.map(row => <li key={row.repo} data-next={row.next}><strong>{row.repo}</strong>: {row.next}. {row.why}</li>)}</ul> : null}
      {summary.nothingToRelease.length ? <p>Up to date: {summary.nothingToRelease.join(', ')}.</p> : null}
    </>}</Value>}
  </Card>;
}
