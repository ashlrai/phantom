/** The `phm jobs yield` report: one sentence, then one table of job kinds with the ones to stop first. */
import type { JobYieldReport } from '../../../../core/fleet/slot-yield.js';
import type { StoppedFamily } from '../../../../core/fleet/stop-file.js';
import styles from './fleet-metrics.module.css';

/** Rows shown before the rest are summed up in one line; the CLI lists them all. */
export const JOB_YIELD_ROWS = 15;
const hoursWords = (hours: number): string => hours === 1 ? 'last hour' : `last ${hours} hours`;

/** "40 minutes", "5 hours", "2 days": the largest whole unit, never zero. */
export function expiresIn(seconds: number): string {
  const [n, unit] = seconds >= 172_800 ? [seconds / 86_400, 'day'] : seconds >= 3600 ? [seconds / 3600, 'hour'] : [Math.max(1, seconds / 60), 'minute'];
  return `${Math.floor(n)} ${unit}${Math.floor(n) === 1 ? '' : 's'}`;
}

/**
 * `report` is undefined while loading or when the server predates the report: the card then reads unknown.
 * `stopped` is the live stop-file rows; null or undefined reads unknown, an empty list reads none.
 */
export function JobYieldCard({ report, stopped }: { report: JobYieldReport | undefined; stopped?: StoppedFamily[] | null }) {
  const usable = report?.schema === 'jobs.yield.v1' && Array.isArray(report.families) ? report : undefined;
  const rows = usable?.known ? usable.families : [];
  const shown = rows.slice(0, JOB_YIELD_ROWS);
  const rest = rows.slice(JOB_YIELD_ROWS);
  const why = usable?.empty_why;
  return <div className={styles.card}>
    <h3 className={styles.heading}>Job yield</h3>
    <p className={styles.note}>{usable ? usable.summary : 'Job yield: unknown'}</p>
    {shown.length ? <div className={styles.scroll}>
      <table className={styles.table}><caption>Job kinds launched in the {hoursWords(usable!.window_hours)}. Stop means 6 or more launches with almost nothing merged.</caption>
        <thead><tr><th scope="col">Job kind</th><th scope="col">Verdict</th><th scope="col">Launches</th><th scope="col">Empty</th><th scope="col">Skipped</th><th scope="col">Merged</th><th scope="col">Merged per launch</th></tr></thead>
        <tbody>{shown.map(row => <tr key={row.family} data-verdict={row.verdict}>
          <th scope="row">{row.family}</th><td>{row.verdict}</td><td>{row.launches}</td><td>{row.empty}</td><td>{row.skipped}</td><td>{row.merged}</td>
          <td>{row.merged_per_launch === null ? 'unknown' : row.merged_per_launch.toFixed(2)}</td></tr>)}</tbody></table>
    </div> : null}
    {rest.length ? <p className={styles.note}>{rest.length} more job {rest.length === 1 ? 'kind' : 'kinds'} with {rest.reduce((sum, row) => sum + row.launches, 0)} launches not shown.</p> : null}
    <h4 className={styles.heading}>Stopped families</h4>
    {!Array.isArray(stopped) ? <p className={styles.note}>Stopped families: unknown</p>
      : !stopped.length ? <p className={styles.note}>No family is stopped.</p>
      : <ul className={styles.stopped}>{stopped.map(row => <li key={`${row.family} ${row.until}`}>
        <strong>{row.family}</strong> <span className={styles.note}>{row.why} · expires in {expiresIn(row.expires_in_s)}</span></li>)}</ul>}
    {why?.known ? <section aria-label="Why jobs ended empty"><h4 className={styles.heading}>Why jobs ended empty</h4>
      <p className={styles.note}>{why.total} empty jobs in the {hoursWords(why.window_hours)}. Ranked by recorded wasted tokens; missing measurements stay unknown.</p>
      <ul className={styles.list}>{why.families.slice(0, JOB_YIELD_ROWS).map(row => <li key={row.family}>{row.family}: {row.wasted_tokens ?? 'unknown'} wasted tokens
        {row.tokens_unknown_jobs ? ` (${row.tokens_unknown_jobs} ${row.tokens_unknown_jobs === 1 ? 'job' : 'jobs'} with unknown tokens)` : ''}; {Object.entries(row.reasons).filter(([, n]) => n).map(([key, n]) => `${n} ${key === 'precheck-catchable' ? 'a precheck could catch' : key.replaceAll('-', ' ')}`).join(', ')}</li>)}</ul>
      {why.families.length > JOB_YIELD_ROWS ? <p className={styles.note}>{why.families.length - JOB_YIELD_ROWS} more families in phm jobs empty-why.</p> : null}
    </section> : null}
  </div>;
}
