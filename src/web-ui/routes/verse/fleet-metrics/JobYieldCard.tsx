/** The `phm jobs yield` report: one sentence, then one table of job kinds with the ones to stop first. */
import type { JobYieldReport } from '../../../../core/fleet/slot-yield.js';
import styles from './fleet-metrics.module.css';

/** Rows shown before the rest are summed up in one line; the CLI lists them all. */
export const JOB_YIELD_ROWS = 15;
const hoursWords = (hours: number): string => hours === 1 ? 'last hour' : `last ${hours} hours`;

/** `report` is undefined while loading or when the server predates the report: the card then reads unknown. */
export function JobYieldCard({ report }: { report: JobYieldReport | undefined }) {
  const usable = report?.schema === 'jobs.yield.v1' && Array.isArray(report.families) ? report : undefined;
  const rows = usable?.known ? usable.families : [];
  const shown = rows.slice(0, JOB_YIELD_ROWS);
  const rest = rows.slice(JOB_YIELD_ROWS);
  return <div className={styles.root}>
    <h3 className={styles.heading}>Job yield</h3>
    <p className={styles.note}>{usable ? usable.summary : 'Job yield: unknown'}</p>
    {shown.length ? <p className={styles.note}>Job kinds launched in the {hoursWords(usable!.window_hours)}. Stop means 6 or more launches with almost nothing merged. Scroll the table sideways to see every column.</p> : null}
    {shown.length ? <div className={styles.scroll} tabIndex={0} role="region" aria-label="Job yield table, scroll for all columns">
      <table className={`${styles.table} ${styles.jobYieldTable}`}><caption className={styles.visuallyHidden}>Job yield by job kind</caption>
        <thead><tr><th scope="col">Job kind</th><th scope="col">Verdict</th><th scope="col">Launches</th><th scope="col">Empty</th><th scope="col">Skipped</th><th scope="col">Merged</th><th scope="col">Merged per launch</th></tr></thead>
        <tbody>{shown.map(row => <tr key={row.family} data-verdict={row.verdict}>
          <th scope="row">{row.family}</th><td>{row.verdict}</td><td>{row.launches}</td><td>{row.empty}</td><td>{row.skipped}</td><td>{row.merged}</td>
          <td>{row.merged_per_launch === null ? 'unknown' : row.merged_per_launch.toFixed(2)}</td></tr>)}</tbody></table>
    </div> : null}
    {rest.length ? <p className={styles.note}>{rest.length} more job {rest.length === 1 ? 'kind' : 'kinds'} with {rest.reduce((sum, row) => sum + row.launches, 0)} launches not shown.</p> : null}
  </div>;
}
