/**
 * routes/verse/sections/MergePaceCard.tsx — how fast the fleet is merging:
 * per repo, merges per hour and the median time to merge over the last six
 * hours. It reads GET /api/verse/fleet/merge-pace, the same report
 * `ashlr fleet merge-pace --json` prints, so agents and humans see one
 * answer. Unknown is never zero: unreadable metrics say so plainly.
 */
import type { MergePaceRow } from '../../../../core/fleet/merge-pace.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { mergePaceQuery } from './merge-pace-query.js';
import styles from '../fleet/fleet.module.css';

/** The ledger moves per merge, not per second; a minute keeps the card warm. */
const MERGE_PACE_POLL_MS = 60_000;

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} sec`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${hours} hr`;
}

/** "2 merges · 0.3 per hour · median 12 min to merge" */
export function mergePaceLine(row: MergePaceRow): string {
  const rate = Math.round(row.merges_per_hour * 10) / 10;
  const median = row.median_ttm_s === null ? 'time to merge unknown' : `median ${duration(row.median_ttm_s)} to merge`;
  return `${row.merges} merge${row.merges === 1 ? '' : 's'} · ${rate} per hour · ${median}`;
}

export function MergePaceCard() {
  const read = useQuery(mergePaceQuery);
  const refetch = useRefetch(mergePaceQuery);
  usePollWhileVisible(refetch, MERGE_PACE_POLL_MS);
  const data = read.data;
  // Loading, or the route is not in this build — say nothing.
  if (data == null) return null;
  const rows = data.rows ?? [];
  const total = rows.find((row) => row.repo === 'total');
  return (
    <div className={styles.mainHealth}>
      <p className={styles.mainHealthLabel}>Merge pace, last 6 hours</p>
      <ul className={styles.mainHealthRows} aria-label="Merge pace per repo">
        {!data.known ? (
          <li className={styles.mainHealthNote}>Unknown — the merge history could not be read.</li>
        ) : total && total.merges === 0 ? (
          <li className={styles.mainHealthNote}>No merges in the last 6 hours.</li>
        ) : (
          rows.map((row) => (
            <li key={row.repo} className={styles.mainHealthRow}>
              <span className={styles.mainHealthRepo}>{row.repo}</span>
              <span className={styles.laneSep} aria-hidden="true">{' · '}</span>
              <span className={styles.mainHealthLine}>{mergePaceLine(row)}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
