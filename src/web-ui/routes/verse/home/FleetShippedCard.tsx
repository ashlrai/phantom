/**
 * Home's Shipped today card: every pull request the fleet merged in the last 24 hours, newest first, from the
 * `phm shipped --since 24h --json` feed (fleet.shipped.v1). Two sentences lead (how many merged and where, the median
 * and longest time open), a row of repository buttons narrows the list, and each row draws the pull request's time
 * open as a line ending in a dot at its merge, on the feed's own 24 hours. A row links to the pull request and, when
 * the feed names the job that made it, opens that job in the Worker log. Read-only; a fact the feed does not hold
 * reads unknown and draws nothing in its place.
 */
import { useState } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { openWords, repoParts, rowSpan, shippedOf, shippedRows, shippedSummary, shippedWindow, type ShippedRow, type ShippedWindow } from './shipped-card-model.js';
import home from './home.module.css';
import styles from './shipped-card.module.css';

const query: QueryDef<unknown> = { key: 'fleet-shipped', fetch: signal => apiGet('/api/verse/shipped?since=24h', signal) };
/** The feed asks GitHub once per repository on every read, so the card asks rarely. */
const POLL_MS = 600_000;
export const shippedTime = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;

function Row({ row, window, onOpenJob }: { row: ShippedRow; window: ShippedWindow | null; onOpenJob?: (job: string) => void }) {
  const span = window ? rowSpan(row, window) : null;
  return <li data-repo={row.repo}>
    {row.mergedMs === null ? <span className={styles.when} data-unknown>time unknown</span>
      : <time className={styles.when} dateTime={new Date(row.mergedMs).toISOString()}>{shippedTime(row.mergedMs)}</time>}
    <span className={styles.what}>
      {row.lane !== null && <ProviderBadge of={row.lane} iconOnly size={14} />}
      <a href={row.href} target="_blank" rel="noreferrer">{row.label} #{row.number}: {row.title}</a>
    </span>
    <span className={styles.facts}>
      <span>{row.lane ?? 'lane unknown'}</span>
      <span>{row.openSeconds === null ? 'open time unknown' : `open ${openWords(row.openSeconds)}`}</span>
      {row.jobId !== null && (onOpenJob && JOB_ID_RE.test(row.jobId)
        ? <button type="button" className={styles.job} aria-label={`Open the worker log for ${row.jobId}`} onClick={() => onOpenJob(row.jobId!)}>{row.jobId}</button>
        : <span>{row.jobId}</span>)}
    </span>
    {span && <span className={styles.track} aria-hidden="true" data-testid="shipped-track">
      {span.from !== null && <span className={styles.life} data-clipped={span.clipped || undefined} style={{ left: percent(span.from), width: percent(span.to - span.from) }} />}
      <span className={styles.dot} data-open={span.from === null ? 'unknown' : undefined} style={{ left: percent(span.to) }} />
    </span>}
  </li>;
}

export function FleetShippedCard({ visible = true, onOpenJob }: { visible?: boolean; onOpenJob?: (job: string) => void }) {
  const read = useQuery(query, { enabled: visible });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, POLL_MS, { enabled: visible });
  const [chosen, setChosen] = useState<string | null>(null);
  const report = shippedOf(read.data);
  const failed = Boolean(read.error) || read.status === 'error';
  // Before the first read, or any other payload (an older server), the card stays hidden.
  if (!report && !failed && read.status !== 'loading') return null;
  const rows = report ? shippedRows(report) : [];
  const parts = repoParts(rows);
  // A repository that left the list on a later read cannot stay chosen and hide every row.
  const repo = parts.some(part => part.repo === chosen) ? chosen : null;
  const shown = repo === null ? rows : rows.filter(row => row.repo === repo);
  const window = report ? shippedWindow(report) : null;
  const summary = report ? shippedSummary(report, rows) : null;
  return <section className={home.card} aria-label="Shipped today">
    <h3>Shipped today</h3>
    <div className={styles.body}>
      {failed ? <p className={styles.note} data-warn role="status">Refresh failed. {report ? `Showing the last report${window ? `, read at ${shippedTime(window.endMs)}` : ''}.` : 'Shipped is unavailable.'}
        <button type="button" className={styles.refresh} onClick={refresh}>Try again</button></p> : null}
      {!report && !failed ? <p className={styles.note} data-reading role="status">Reading shipped work…</p> : null}
      {summary && <>
        <p className={styles.headline}>{summary.headline}</p>
        {summary.pace && <p className={styles.note}>{summary.pace}</p>}
      </>}
      {parts.length > 1 && <div className={styles.repos} role="group" aria-label="Show one repository">
        <button type="button" className={styles.repo} aria-pressed={repo === null} onClick={() => setChosen(null)}>All <strong>{rows.length}</strong></button>
        {parts.map(part => <button key={part.repo} type="button" className={styles.repo} aria-pressed={repo === part.repo} onClick={() => setChosen(repo === part.repo ? null : part.repo)}>
          {part.label} <strong>{part.merged}</strong><span className={styles.share} aria-hidden="true" style={{ width: percent(part.share) }} />
        </button>)}
      </div>}
      {shown.length > 0 && <>
        {window && <p className={styles.axis} aria-hidden="true"><span>{shippedTime(window.startMs)}</span><span>line: time open · dot: merged</span><span>{shippedTime(window.endMs)}</span></p>}
        <ol className={styles.rows} aria-label={`Merged pull requests, newest first${repo === null ? '' : `, ${parts.find(part => part.repo === repo)!.label} only`}`}>
          {shown.map(row => <Row key={row.key} row={row} window={window} onOpenJob={onOpenJob} />)}
        </ol>
      </>}
      {report && <p className={styles.note}>{window ? `Read at ${shippedTime(window.endMs)}. ` : ''}The same list: <code className={home.command}>phm shipped --since 24h</code></p>}
    </div>
  </section>;
}
