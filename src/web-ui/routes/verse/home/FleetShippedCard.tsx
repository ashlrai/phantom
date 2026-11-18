import type { FleetShippedReport } from '../../../../core/fleet/shipped.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './home.module.css';

const query: QueryDef<FleetShippedReport> = { key: 'fleet-shipped', fetch: signal => apiGet('/api/verse/shipped?since=24h', signal) };
export function FleetShippedCard({ visible = true }: { visible?: boolean }) {
  const read = useQuery(query, { enabled: visible });
  const report = read.data?.schema === 'fleet.shipped.v1' ? read.data : null;
  if (!report && !read.error && read.status !== 'loading' && read.status !== 'error') return null;
  return <section className={styles.card} aria-label="Shipped today">
    <h3>Shipped today</h3><p>Merged in the last 24 hours, newest first.</p>
    {read.error || read.status === 'error' ? <p role="status">Refresh failed. {report ? 'Showing the last report.' : 'Shipped is unavailable.'}</p> : null}
    {!report && read.status === 'loading' ? <p>Loading shipped work…</p> : null}
    {report && <>
      {!report.complete ? <p role="status">Some results are unavailable. Totals are unknown.</p> :
        <p>{report.totals.merged} merged · {report.totals.mergedPerHour?.toFixed(1)} per hour · Median open to merge: {report.totals.medianOpenToMergeSeconds === null ? 'unknown' : `${Math.round(report.totals.medianOpenToMergeSeconds / 60)} minutes`}.</p>}
      {report.complete && !report.items.length ? <p>Nothing merged in the last 24 hours.</p> : null}
      <ul style={{ maxHeight: '16rem', overflowY: 'auto' }}>{report.items.map(pr => <li key={`${pr.repo}#${pr.number}`}>
        <a href={`https://github.com/${pr.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer">{pr.repo.replace('ashlrai/', '')} #{pr.number}: {pr.title}</a>
        <small> · {pr.jobId ? `${pr.jobId} · ` : ''}{pr.lane ?? 'Unknown lane'} · {pr.openToMergeSeconds == null ? 'Open time unknown' : `${Math.round(pr.openToMergeSeconds / 60)} minutes open`}</small>
      </li>)}</ul>
    </>}
  </section>;
}
