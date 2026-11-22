/** Fleet view card: jobs started per hour, wasted starts, the longest gap and the top change, from `phm fleet launches --json`. */
import { useId } from 'react';
import type { LaunchRateReport } from '../../../../core/fleet/launch-rate.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './runs-lanes.module.css';

export const launchesQuery: QueryDef<LaunchRateReport> = {
  key: 'verse-fleet-runs-launches-24',
  fetch: signal => apiGet<LaunchRateReport>('/api/verse/fleet/runs/launches?hours=24', signal),
};

/** Same words as the CLI's gap text ("45 m", "2 h 10 m"); the core module reads files, so it stays out of the browser bundle. */
export function gapWords(minutes: number): string {
  const whole = Math.round(minutes), h = Math.floor(whole / 60), m = whole % 60;
  return h === 0 ? `${m} m` : m === 0 ? `${h} h` : `${h} h ${m} m`;
}

export function LaunchesCard() {
  const id = useId();
  const read = useQuery(launchesQuery);
  const refresh = useRefetch(launchesQuery);
  usePollWhileVisible(refresh, 60_000);
  // An older server or an error body is not a measurement.
  const report = read.data?.schema === 'fleet.launches.v1' ? read.data : null;
  const known = report !== null && report.metrics === 'ok';
  const shown = (value: number | null | undefined): string => value === null || value === undefined || !known ? 'unknown' : String(value);
  const repeats = known && Array.isArray(report.repeat_jobs) ? report.repeat_jobs.slice(0, 3) : [];
  const gap = known && report.longest_gap ? gapWords(report.longest_gap.minutes) : 'unknown';
  return <section className={styles.panel} aria-labelledby={id} data-testid="launches-card">
    <header className={styles.header}><h2 id={id}>Job starts, last 24 h</h2>
      <span>Same as <code>phm fleet launches --json</code></span></header>
    {report ? <>
      <dl className={styles.numbers} aria-label="Start rate">
        <div><dt>Starts per hour</dt><dd>{shown(report.starts_per_hour)}</dd></div>
        <div><dt>Wasted starts</dt><dd>{known ? `${report.wasted_starts} of ${report.starts}` : 'unknown'}</dd></div>
        <div><dt>Longest gap</dt><dd>{gap}</dd></div>
      </dl>
      <p role="status">{report.recommendations[0] ?? 'Nothing to change.'}</p>
      {repeats.length ? <div data-testid="relaunches-list">
        <h3>Jobs spending starts with no merged PR</h3>
        <ul>{repeats.map(job => <li key={job.job}><code>{job.job}</code>: {job.summary}; suggest: {job.suggest}</li>)}</ul>
        <p>Next: <code>{repeats[0]!.job}</code>, {repeats[0]!.suggest}. Same list as <code>phm fleet relaunches</code></p>
      </div> : null}
      {read.status === 'error' ? <p role="status">Could not refresh. Showing the last reading.</p> : null}
    </> : <p role="status">{read.status === 'error' || read.data ? 'Job starts: unknown (the report could not be read).' : 'Reading job starts…'}</p>}
  </section>;
}
