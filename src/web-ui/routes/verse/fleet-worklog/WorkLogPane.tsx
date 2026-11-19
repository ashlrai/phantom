/** Work log pane: the `phm fleet worklog` report. One sentence and one hourly trend line per number, then today against yesterday by lane and by repo.
 * Every sentence and count comes from GET /api/fleet/worklog; nothing is summed in the browser. */
import type { FleetWorklogReport, WorklogCounts, WorklogNumber } from '../../../../core/fleet/worklog-numbers.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-worklog.module.css';

const QUERY: QueryDef<FleetWorklogReport> = { key: 'fleet-worklog', fetch: signal => apiGet('/api/fleet/worklog?hours=24', signal) };
/** What each trend line draws, and the factor that turns the stored value into that unit. */
const TREND: Record<WorklogNumber, [label: string, scale: number]> = {
  merged: ['PRs merged', 1], median_ttm_s: ['Median minutes from PR opened to merged', 1 / 60], merged_per_launch: ['Merged PRs per 100 launches', 100],
  empty: ['Launches that ended with no change', 1], launches: ['Launches', 1],
};
const shown = (value: number | null | undefined): string => value == null ? 'unknown' : String(value);
const minutes = (seconds: number | null | undefined): string => seconds == null ? 'unknown' : String(Math.round(seconds / 6) / 10);
const when = (stamp: string): string => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Groups({ title, today, yesterday }: { title: string; today: Record<string, WorklogCounts>; yesterday: Record<string, WorklogCounts> | null }) {
  const names = [...new Set([...Object.keys(today), ...Object.keys(yesterday ?? {})])].sort((a, b) => (today[b]?.merged ?? 0) - (today[a]?.merged ?? 0) || a.localeCompare(b));
  if (!names.length) return <p className={styles.meta}>No work recorded by {title.toLowerCase()} today or yesterday.</p>;
  // A name with no row on a recorded day did nothing that day, which is a counted zero. `yesterday` is null when it was not recorded.
  const count = (c: WorklogCounts | undefined, key: 'merged' | 'launches' | 'empty') => c ? shown(c[key]) : '0';
  return <div className={styles.tableScroll} role="region" aria-label={`Work log by ${title.toLowerCase()}, scroll for all columns`} tabIndex={0}><table className={styles.table}>
    <caption>By {title.toLowerCase()}</caption>
    <thead><tr><th scope="col">{title}</th><th scope="col">Merged today</th><th scope="col">Merged yesterday</th><th scope="col">Launches today</th><th scope="col">No change today</th><th scope="col">Median minutes to merge today</th></tr></thead>
    <tbody>{names.map(name => <tr key={name}><th scope="row">{name}</th><td>{count(today[name], 'merged')}</td><td>{yesterday ? count(yesterday[name], 'merged') : 'unknown'}</td>
      <td>{count(today[name], 'launches')}</td><td>{count(today[name], 'empty')}</td><td>{minutes(today[name]?.median_ttm_s)}</td></tr>)}</tbody>
  </table></div>;
}

function Report({ report }: { report: FleetWorklogReport }) {
  if (!report.known) return <p className={styles.meta} role="status">Work log: unknown (the job metrics file could not be read).</p>;
  const today = report.daily.at(-1), yesterday = report.daily.at(-2);
  return <>
    <ul className={styles.numbers}>{report.compare.map(row => {
      const [label, scale] = TREND[row.number];
      return <li key={row.number}><span>{row.text}.</span>
        <Sparkline points={report.hourly.map(hour => hour[row.number] === null ? null : Math.round(hour[row.number]! * scale * 10) / 10)}
          width={120} ariaLabel={`${label}, each hour of the last ${report.hours}`} describe={String} /></li>;
    })}</ul>
    {today ? (['Lane', 'Repo'] as const).map(title => { const key = title === 'Lane' ? 'by_lane' : 'by_repo';
      return <Groups key={title} title={title} today={today[key]} yesterday={yesterday?.merged == null ? null : yesterday[key]} />; }) : null}
    <p className={styles.meta}>Updated {when(report.as_of)}. Today is still in progress. Same numbers: <code>phm fleet worklog --json</code></p>
  </>;
}

export function WorkLogPane({ visible }: PaneProps) {
  const read = useQuery(QUERY, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(QUERY);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  // Any other payload (an older server, an error body) is not a measurement.
  const report = read.data?.schema === 'fleet.worklog.v1' ? read.data : null;
  return <section className={styles.root} aria-label="Work log">
    <h2>Work log</h2>
    {/* A failed refresh keeps the last report on screen; it must not read as current. */}
    {report && read.status === 'error' ? <p className={styles.meta} data-stale role="status">Could not refresh. Showing the last reading.</p> : null}
    {report ? <Report report={report} />
      : <p className={styles.meta} role="status">{read.status === 'error' || read.data ? 'Work log: unknown (the report could not be read).' : 'Reading the work log…'}</p>}
  </section>;
}
