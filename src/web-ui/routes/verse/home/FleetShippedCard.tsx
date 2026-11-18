/**
 * Home's Shipped today card: what merged in the last 24 hours. The count leads, then when it merged (one bar per hour),
 * where (a count per repo) and the PRs themselves, newest first. A PR's job id opens that session's messages.
 * Built only on `GET /api/verse/shipped?since=24h` (fleet.shipped.v1). Read-only, and read once per visit: the route asks
 * GitHub, so the card does not poll it. An incomplete report has no total, and a PR with no recorded lane, job or open time says so.
 */
import { useId, useState } from 'react';
import type { FleetShippedReport, ShippedPr } from '../../../../core/fleet/shipped.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { hourlyMerges, openFor, repoShares, SHIPPED_HOURS, type HourlyMerges } from './fleet-shipped-model.js';
import home from './home.module.css';
import styles from './shipped.module.css';

const query: QueryDef<FleetShippedReport> = { key: 'fleet-shipped', fetch: signal => apiGet('/api/verse/shipped?since=24h', signal) };
/** Home is a glance; the rest of the day is one button away. */
export const SHIPPED_LIMIT = 6;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One bar per hour, oldest on the left. The label carries every count, so the picture is never the only copy. */
function Hours({ hourly, partial }: { hourly: HourlyMerges; partial: boolean }) {
  const { counts } = hourly;
  const most = Math.max(...counts);
  const peak = Math.max(1, most);
  return <>
    <svg className={styles.hours} viewBox={`0 0 ${SHIPPED_HOURS} 20`} preserveAspectRatio="none" role="img"
      aria-label={`${partial ? 'Listed PRs merged' : 'Merged'} per hour over the last 24 hours, oldest first: ${counts.join(', ')}`}>
      {counts.map((count, hour) => count === 0
        ? <rect key={hour} data-empty x={hour + 0.1} y={19.5} width={0.8} height={0.5} fill="currentColor" />
        : <rect key={hour} x={hour + 0.1} y={20 - (count / peak) * 19} width={0.8} height={(count / peak) * 19} fill="currentColor" />)}
    </svg>
    <span className={styles.axis} aria-hidden="true"><span>24 hours ago</span><span>most in one hour: {most}</span><span>now</span></span>
  </>;
}

function Pr({ pr, onOpenJob }: { pr: ShippedPr; onOpenJob?: (job: string) => void }) {
  const at = new Date(pr.mergedAt ?? '');
  const job = pr.jobId;
  return <li className={styles.pr}>
    {Number.isNaN(at.getTime()) ? <span className={styles.when} data-unknown>time unknown</span>
      : <time className={styles.when} dateTime={pr.mergedAt}>{at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>}
    <a className={styles.title} href={`https://github.com/${pr.repo}/pull/${pr.number}`} target="_blank" rel="noreferrer">
      <span className={styles.number}>{pr.repo.replace('ashlrai/', '')} #{pr.number}:</span> {pr.title}</a>
    <span className={styles.meta}>
      {!job ? null : onOpenJob && JOB_ID_RE.test(job)
        ? <button type="button" className={styles.job} aria-label={`Open messages for ${job}`} onClick={() => onOpenJob(job)}>{job}</button>
        : <span className={styles.jobText}>{job}</span>}
      <span>{pr.lane ?? 'Unknown lane'}</span>
      <span>{pr.openToMergeSeconds == null ? 'Open time unknown' : `open ${openFor(pr.openToMergeSeconds)}`}</span>
    </span>
  </li>;
}

function Report({ report, onOpenJob }: { report: FleetShippedReport; onOpenJob?: (job: string) => void }) {
  const listId = useId();
  const [all, setAll] = useState(false);
  const { totals } = report;
  const hourly = report.items.length > 0 ? hourlyMerges(report.items, report.generatedAt) : null;
  // A partial read's per-repo counts are partial too, so they are not shown as the day's split.
  const repos = report.complete ? repoShares(report.byRepo) : [];
  const more = report.items.length - SHIPPED_LIMIT;
  return <>
    {!report.complete || totals.merged === null ? <p role="status" data-warn>Some results are unavailable. Totals are unknown.</p>
      : totals.merged === 0 ? <p>Nothing merged in the last 24 hours.</p>
        : <p className={styles.total}><span className={styles.count}>{totals.merged} merged</span>
          <span className={styles.fact}>{totals.mergedPerHour === null ? 'rate unknown' : `${totals.mergedPerHour.toFixed(1)} per hour`}
            {' · '}median open to merge: {totals.medianOpenToMergeSeconds === null ? 'unknown' : openFor(totals.medianOpenToMergeSeconds)}</span></p>}
    {hourly ? <Hours hourly={hourly} partial={!report.complete} /> : null}
    {hourly && !report.complete ? <p className={styles.fact}>Only the PRs listed below are drawn.</p> : null}
    {hourly && hourly.unplaced > 0 ? <p className={styles.fact}>{plural(hourly.unplaced, 'PR')} with no merge time in this window left out of the chart.</p> : null}
    {repos.length > 1 ? <ul className={styles.repos} aria-label="Merged by repo">{repos.map(({ repo, count }) => <li key={repo}>{repo} <strong>{count}</strong></li>)}</ul> : null}
    {report.items.length > 0 && <ul id={listId} className={styles.prs} aria-label="Merged PRs, newest first">
      {(all ? report.items : report.items.slice(0, SHIPPED_LIMIT)).map(pr => <Pr key={`${pr.repo}#${pr.number}`} pr={pr} onOpenJob={onOpenJob} />)}
    </ul>}
    {more > 0 && <button type="button" className={home.action} aria-expanded={all} aria-controls={listId} onClick={() => setAll(!all)}>
      {all ? `Show the newest ${SHIPPED_LIMIT}` : `Show all ${report.items.length}`}</button>}
  </>;
}

export function FleetShippedCard({ visible = true, onOpenJob }: { visible?: boolean; onOpenJob?: (job: string) => void }) {
  const read = useQuery(query, { enabled: visible });
  // Any other payload (an older server, an error body) is not a report.
  const report = read.data?.schema === 'fleet.shipped.v1' && Array.isArray(read.data.items) && read.data.totals ? read.data : null;
  const failed = Boolean(read.error) || read.status === 'error';
  if (!report && !failed && read.status !== 'loading') return null;
  return <section className={home.card} aria-label="Shipped today">
    <h3>Shipped today</h3>
    {failed ? <p role="status" data-warn>{report ? 'Could not refresh. Showing the last report, which may be stale.' : 'Unknown: what shipped could not be read.'}</p> : null}
    {!report && !failed ? <p>Reading shipped work…</p> : null}
    {report ? <Report report={report} onOpenJob={onOpenJob} /> : null}
  </section>;
}
