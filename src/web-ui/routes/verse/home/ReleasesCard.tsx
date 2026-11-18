import { releasesSchema, releaseRowLine, type ReleasesV1 } from '../../../../core/release/releases-shape.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

const query: QueryDef<ReleasesV1> = { key: 'fleet-releases', fetch: signal => apiGet('/api/verse/fleet/runs/releases', signal) };
export function ReleasesCard({ visible }: { visible: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 60_000 }), refresh = useRefetch(query);
  usePollWhileVisible(refresh, 600_000, { enabled: visible });
  const parsed = releasesSchema.safeParse(read.data);
  const failed = Boolean(read.error) || read.status === 'error';
  const stale = failed && parsed.success;
  const lastSuccess = read.updatedAt === null ? null : new Date(read.updatedAt).toISOString();
  return <section className={styles.card} aria-label="Releases"><h3>Releases</h3><p>PRs merged since the latest stable publication.</p>
    {stale ? <p role="status">Refresh failed; showing the last release report, which may be stale. Last successful update:{' '}
      {lastSuccess === null ? 'time unavailable' : <time dateTime={lastSuccess}>{lastSuccess}</time>}.</p> : null}
    {failed && !parsed.success ? <p role="status">Release report unavailable right now. Try again.</p>
      : parsed.success ? <><ul className={styles.releaseList}>{parsed.data.repos.map(row => <li key={row.repo} data-unknown={row.freshness === 'unknown' || undefined}>{releaseRowLine(row)}</li>)}</ul>
        <p>Checked <time dateTime={parsed.data.asOf}>{new Date(parsed.data.asOf).toLocaleTimeString()}</time></p></>
        : <p data-unknown>{read.data ? 'Unknown: the release report could not be read.' : 'Reading releases…'}</p>}
    <button type="button" className={styles.action} onClick={refresh}>Check again</button>
  </section>;
}
