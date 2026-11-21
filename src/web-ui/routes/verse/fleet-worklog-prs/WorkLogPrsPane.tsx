/** Shipped PRs pane: the `phm worklog --prs` report. One line per merged PR, newest first, grouped by hour with a count per hour.
 * Everything shown comes from GET /api/verse/fleet/worklog; nothing is counted in the browser. */
import { useState, type KeyboardEvent } from 'react';
import type { ShippedPr, WorklogPrsReport } from '../../../../core/fleet/worklog-prs.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-worklog-prs.module.css';

const QUERY: QueryDef<WorklogPrsReport> = { key: 'fleet-worklog-prs', fetch: signal => apiGet('/api/verse/fleet/worklog?hours=24', signal) };
const clock = (stamp: string): string => new Date(stamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const hourLabel = (stamp: string): string => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

function open(pr: ShippedPr | undefined): void {
  if (pr?.url) window.open(pr.url, '_blank', 'noopener,noreferrer');
}

function Feed({ report }: { report: WorklogPrsReport }) {
  const [active, setActive] = useState(0);
  const flat = report.hourly.flatMap(hour => hour.prs);
  if (!flat.length) return <p className={styles.meta} role="status">No PRs merged in the last {report.hours ?? 24} hours.{report.noPr ? ` ${report.noPr} ended with no PR.` : ''}</p>;
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') setActive(i => Math.min(i + 1, flat.length - 1));
    else if (event.key === 'ArrowUp') setActive(i => Math.max(i - 1, 0));
    else if (event.key === 'Enter') open(flat[active]);
    else return;
    event.preventDefault();
  };
  let index = -1;
  return <ul className={styles.list} role="listbox" aria-label="Merged PRs, newest first" tabIndex={0} aria-activedescendant={`worklog-pr-${active}`} onKeyDown={onKey}>
    {report.hourly.map(hour => <li key={hour.hour} role="presentation">
      <p className={styles.hour}>{hourLabel(hour.hour)}: {hour.merged} merged{hour.noPr ? `, ${hour.noPr} ended with no PR` : ''}</p>
      <ul className={styles.list} role="presentation">{hour.prs.map(pr => { const mine = ++index;
        return <li key={`${pr.url ?? pr.job}-${mine}`} id={`worklog-pr-${mine}`} role="option" aria-selected={mine === active} className={styles.pr}
          onClick={() => { setActive(mine); open(pr); }}>
          <span>{clock(pr.mergedAt)}</span><span>{pr.repo ?? 'unknown repo'}{pr.pr === null ? '' : ` #${pr.pr}`}</span><span>{pr.title ?? 'unknown title'}</span>
          <small>{pr.lane ?? 'unknown lane'} · {pr.model ?? 'unknown model'} · {pr.minutes === null ? 'unknown' : pr.minutes} min to merge</small>
        </li>; })}</ul>
    </li>)}
  </ul>;
}

export function WorkLogPrsPane({ visible }: PaneProps) {
  const read = useQuery(QUERY, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(QUERY);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = read.data?.schema === 'fleet.worklog-prs.v1' ? read.data : null;
  return <section className={styles.root} aria-label="Shipped PRs">
    <h2>Shipped PRs</h2>
    {report && read.status === 'error' ? <p className={styles.meta} data-stale role="status">Could not refresh. Showing the last reading.</p> : null}
    {report ? <>
      <Feed report={report} />
      {report.sources.jobs.state === 'unknown' ? <p className={styles.meta} role="status">Unknown: job results. {report.sources.jobs.reason}</p> : null}
      <p className={styles.meta}>Same list: <code>phm worklog --prs --json</code></p>
    </> : <p className={styles.meta} role="status">{read.status === 'error' || read.data ? 'Shipped PRs: unknown (the report could not be read).' : 'Reading what the fleet shipped…'}</p>}
  </section>;
}
