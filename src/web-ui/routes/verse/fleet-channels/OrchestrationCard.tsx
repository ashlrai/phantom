import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { orchestrationQuery } from './orchestration-query.js';
import type { OrchestrationView } from './orchestration-model.js';
import styles from './fleet-channels.module.css';

/** Read-only view of durable specialist assignments. */
export function OrchestrationCard({ visible, nowMs }: { visible: boolean; nowMs: number }) {
  const read = useQuery(orchestrationQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(orchestrationQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });
  if (read.data === null) return null;
  if (read.data === undefined) {
    return <p className={styles.message} role="status">{read.status === 'error' ? 'Orchestration journal is unavailable.' : 'Reading orchestration journal…'}</p>;
  }
  return <OrchestrationBody view={read.data} nowMs={nowMs} />;
}

export function OrchestrationBody({ view, nowMs }: { view: OrchestrationView; nowMs: number }) {
  const when = (iso: string) => formatRelative(iso, nowMs);
  return <section className={styles.root} aria-label="Leader orchestration journal" data-testid="orchestration-journal">
    <strong>Leader orchestration journal</strong>
    <p className={styles.header}>{view.header}</p>
    {view.unresolved.length > 0 && <>
      <strong>Unresolved reservations</strong>
      <ul className={styles.list} aria-label="Unresolved reservations">
        {view.unresolved.map((r, i) => <li className={styles.row} key={i}>
          <span>{r.job} · {r.specialist} · <time dateTime={r.assignedAt}>{when(r.assignedAt)}</time></span>
        </li>)}
      </ul>
    </>}
    {view.truncated && <p className={styles.message}>Showing the newest {view.rows.length} assignments.</p>}
    {view.rows.length > 0 && <table aria-label="Orchestration assignments">
      <thead><tr><th>Job</th><th>Specialist</th><th>Status</th><th>Assigned</th></tr></thead>
      <tbody>{view.rows.map((r, i) => <tr key={i}>
        <td>{r.job}</td><td>{r.specialist}</td><td><span className={styles.healthBadge}>{r.status}</span></td>
        <td><time dateTime={r.assignedAt}>{when(r.assignedAt)}</time></td>
      </tr>)}</tbody>
    </table>}
  </section>;
}
