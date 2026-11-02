/**
 * routes/verse/fleet/MainHealthRows.tsx — one compact row per repo: the main
 * guardian's verdict — state, minutes red, repair attempts and the job
 * driving the fix. It reads GET /api/verse/fleet/main-red-age, the same
 * projection `ashlr fleet main-red-age` prints, so agents and humans see one
 * answer. Unknown is never green: an unread state file says so plainly
 * instead of listing nothing.
 */
import type { RedAgeRow } from '../../../../core/fleet/main-red-age.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { mainRedAgeQuery } from './main-red-age-query.js';
import styles from './fleet.module.css';

/** guardian/state.json is minute-scale; 30 s keeps the rows warm without hammering. */
const MAIN_HEALTH_POLL_MS = 30_000;

/** "red 12 min · 2 attempts · fix RQ-1" — the row's status half, same words as the CLI. */
export function mainHealthLine(row: RedAgeRow): string {
  const state = row.state === 'red' && row.redMinutes !== null ? `red ${row.redMinutes} min` : row.state;
  const attempts = row.attempts === null ? 'attempts unknown' : `${row.attempts} attempt${row.attempts === 1 ? '' : 's'}`;
  return `${state} · ${attempts}${row.currentJob ? ` · fix ${row.currentJob}` : ''}`;
}

export function MainHealthRows() {
  const read = useQuery(mainRedAgeQuery);
  const refetch = useRefetch(mainRedAgeQuery);
  usePollWhileVisible(refetch, MAIN_HEALTH_POLL_MS);
  const data = read.data;
  // Loading, or the route is not in this build — say nothing.
  if (data == null) return null;
  return (
    <div className={styles.mainHealth}>
      <p className={styles.mainHealthLabel}>Main health</p>
      <ul className={styles.mainHealthRows} aria-label="Main health per repo">
        {!data.known ? (
          <li className={styles.mainHealthNote}>Unknown — the guardian state could not be read.</li>
        ) : data.repos.length === 0 ? (
          <li className={styles.mainHealthNote}>No repos in the guardian state.</li>
        ) : (
          data.repos.map((row) => (
            <li key={row.repo} className={styles.mainHealthRow} data-state={row.state}>
              <span className={styles.mainHealthRepo}>{row.repo}</span>
              <span className={styles.laneSep} aria-hidden="true">{' · '}</span>
              <span className={styles.mainHealthLine}>{mainHealthLine(row)}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
