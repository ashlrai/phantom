/**
 * Home's Work log card: what the fleet did in the last 24 hours, from the `phm worklog --hours 24 --json` report
 * (worklog.v3). One sentence counts the events by kind, a row per kind draws when they happened across the report's
 * hours, and the newest events follow with their kind, pull request link and job. A kind's name narrows the list to
 * that kind. Until the report answers (or on a server that does not serve it) the card lists the few rows the Home
 * summary carries. Read-only; a source the report could not read is named, never counted as a quiet day.
 */
import { useState } from 'react';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import type { WorklogKind } from '../../../../core/fleet/worklog-types.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { cellWords, dayEvents, daySentence, dayWindow, kindRows, unreadSources, worklogOf, KIND_LABEL, type DayEvent, type KindRow } from './worklog-card-model.js';
import home from './home.module.css';
import styles from './worklog-card.module.css';

const HOURS = 24;
/** The Work log view's own 24 hour read, so the two share one cached answer. */
const query: QueryDef<unknown> = { key: `worklog:${HOURS}`, fetch: signal => apiGet(`/api/worklog?hours=${HOURS}`, signal) };
/** Rows listed on Home; the rest stay one click away in the Work log. */
const LISTED = 8;
export const worklogTime = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function Event({ event, onOpenJob }: { event: DayEvent; onOpenJob?: (job: string) => void }) {
  return <li data-kind={event.kind}>
    {event.atMs === null ? <span className={styles.when} data-unknown>time unknown</span>
      : <time className={styles.when} dateTime={new Date(event.atMs).toISOString()}>{worklogTime(event.atMs)}</time>}
    <span className={styles.kind}>{KIND_LABEL[event.kind]}</span>
    <span className={styles.what}>
      {event.lane !== null && <ProviderBadge of={event.lane} iconOnly size={14} />}
      {event.href !== null ? <a href={event.href} target="_blank" rel="noreferrer">{event.text}</a> : <span>{event.text}</span>}
      {event.count > 1 && <span className={styles.times}>{event.count} times</span>}
      {event.job !== null && onOpenJob && JOB_ID_RE.test(event.job)
        && <button type="button" className={styles.job} aria-label={`Open the worker log for ${event.job}`} onClick={() => onOpenJob(event.job!)}>{event.job}</button>}
    </span>
  </li>;
}

function Day({ rows, chosen, onChoose, legend }: { rows: KindRow[]; chosen: WorklogKind | null; onChoose: (kind: WorklogKind) => void; legend: [string, string, string] | null }) {
  return <>
    <ul className={styles.day} aria-label="The day by kind">
      {rows.map(row => <li key={row.kind} data-kind={row.kind}>
        <button type="button" className={styles.pick} aria-pressed={chosen === row.kind} onClick={() => onChoose(row.kind)}>{row.label} <strong>{row.events}</strong></button>
        {row.cells.length > 0 && <span className={styles.cells} aria-hidden="true" data-testid={`worklog-cells-${row.kind}`}>
          {row.cells.map((n, i) => <span key={i} data-n={n || undefined} style={n ? { opacity: 0.3 + 0.7 * (n / row.peak) } : undefined} />)}
        </span>}
        <span className={styles.last}>{row.lastMs === null ? 'time unknown' : `last ${worklogTime(row.lastMs)}`}</span>
      </li>)}
    </ul>
    {legend && <p className={styles.axis} aria-hidden="true"><span>{legend[0]}</span><span>{legend[1]}</span><span>{legend[2]}</span></p>}
  </>;
}

export function WorklogCard({ summary, visible = true, onOpen, onOpenJob }: { summary: HomeSummary['worklog']; visible?: boolean; onOpen: () => void; onOpenJob?: (job: string) => void }) {
  const read = useQuery(query, { enabled: visible });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const [picked, setPicked] = useState<WorklogKind | null>(null);
  const report = worklogOf(read.data);
  const failed = Boolean(read.error) || read.status === 'error';
  const action = <button type="button" className={home.action} onClick={onOpen}>Open Work log</button>;

  // No full report (first read still out, an older server, a failed read): the summary's own newest rows.
  if (!report) {
    const few = summary.state === 'ok' ? dayEvents(summary.value) : [];
    return <section className={home.card} aria-label="Work log">
      <h3>Work log</h3>
      <div className={styles.body}>
        {summary.state !== 'ok' ? <p><span data-unknown>Unknown: {summary.reason}</span></p>
          : few.length ? <ul className={styles.rows} aria-label="Work log, newest first">{few.map(event => <Event key={event.key} event={event} />)}</ul>
          : <p>No work recorded in the last 24 hours.</p>}
        {failed && <p className={styles.note} data-warn role="status">The full day could not be read. {few.length ? 'Showing the newest lines from the fleet summary.' : ''}</p>}
      </div>
      {action}
    </section>;
  }

  const events = dayEvents(report.rows);
  const hours = typeof report.hours === 'number' && report.hours > 0 ? report.hours : null;
  const window = dayWindow(hours, read.updatedAt);
  const rows = kindRows(events, window);
  // A kind that left the report on a later read cannot stay chosen and hide every row.
  const chosen = rows.some(row => row.kind === picked) ? picked : null;
  const shown = chosen === null ? events : events.filter(event => event.kind === chosen);
  const unread = unreadSources(report);
  const rest = shown.length - LISTED;
  return <section className={home.card} aria-label="Work log">
    <h3>Work log</h3>
    <div className={styles.body}>
      {failed && <p className={styles.note} data-warn role="status">Refresh failed. Showing the last report{window ? `, read at ${worklogTime(window.endMs)}` : ''}.</p>}
      <p className={styles.headline}>{daySentence(rows, hours)}</p>
      {unread.length > 0 && <p className={styles.note} data-unknown>Not read, so not counted: {unread.join(' ')}</p>}
      {rows.length > 0 && <Day rows={rows} chosen={chosen} onChoose={kind => setPicked(chosen === kind ? null : kind)}
        legend={window && hours !== null ? [worklogTime(window.startMs), `each square: ${cellWords(hours)} · darker: more in its row`, worklogTime(window.endMs)] : null} />}
      {shown.length > 0 && <ol className={styles.rows} aria-label={`Work log, newest first${chosen === null ? '' : `, ${KIND_LABEL[chosen].toLowerCase()} only`}`}>
        {shown.slice(0, LISTED).map(event => <Event key={event.key} event={event} onOpenJob={onOpenJob} />)}
      </ol>}
      <p className={styles.note}>{rest > 0 ? `${rest} earlier ${rest === 1 ? 'line is' : 'lines are'} in the Work log. ` : ''}The same report: <code className={home.command}>phm worklog --hours {HOURS}</code></p>
    </div>
    {action}
  </section>;
}
