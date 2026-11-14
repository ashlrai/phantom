/**
 * routes/verse/fleet-board/RecheckHistoryStrip.tsx — compact history under the
 * "Server recheck" line: how long the current overall state has held and the
 * latest section transitions. Read-only; renders nothing on older servers.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { deriveRecheckHistory, recheckHistoryQuery } from './recheck-history-model.js';
import styles from './fleet-board.module.css';

export function RecheckHistoryStrip({ visible = true }: { visible?: boolean }) {
  const history = useQuery(recheckHistoryQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(recheckHistoryQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });

  if (history.data === null) return null;
  if (history.data === undefined && history.status !== 'error') {
    return <section className={styles.recheckHistory} aria-label="Recheck history"><SkeletonLine width="40%" /></section>;
  }
  const view = deriveRecheckHistory(history.data, Date.now());
  return (
    <section className={styles.recheckHistory} aria-label="Recheck history">
      <p className={styles.recheckHeld}>{view.held}</p>
      {view.changes.length > 0 ? (
        <ul className={styles.recheckChanges}>
          {view.changes.map((c) => <li key={`${c.asOf}|${c.text}`}>{c.text}</li>)}
        </ul>
      ) : null}
      {view.note ? <p className={styles.recheckNote}>{view.note}</p> : null}
    </section>
  );
}
