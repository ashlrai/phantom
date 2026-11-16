import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatAge, formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { teammateTasksQuery } from './teammate-tasks-query.js';
import type { TeammateTaskRow, TeammateTasksView, TeammateWorkState } from './teammate-tasks-model.js';
import styles from './fleet-channels.module.css';

/** Read-only: tasks handed to Dot/Instinct and their work state from the teammate-task ledger. */
export function TeammateTasksCard({ visible, nowMs }: { visible: boolean; nowMs: number }) {
  const read = useQuery(teammateTasksQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(teammateTasksQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });
  if (read.data === null) return null; // build without the route
  if (read.data === undefined) {
    return <p className={styles.message} role="status">{read.status === 'error' ? 'Teammate tasks are unavailable.' : 'Reading teammate tasks…'}</p>;
  }
  return <TeammateTasksBody view={read.data} nowMs={nowMs} />;
}

// Nothing in this ledger is independently verified, so "done" is always peer-reported.
const LABELS: Record<TeammateWorkState, string> = {
  RECEIVED: 'RECEIVED', ASSIGNED: 'ASSIGNED', RUNNING: 'RUNNING', BLOCKED: 'BLOCKED', CANCELLED: 'CANCELLED',
  REPORTED_DONE: 'Done (peer-reported, unverified)', UNKNOWN: 'UNKNOWN',
};
const ACTIVE = new Set<TeammateWorkState>(['RECEIVED', 'ASSIGNED', 'RUNNING']);

function deadlineText(row: TeammateTaskRow, nowMs: number): string {
  const ms = Date.parse(row.deadline);
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms > nowMs) return `in ${formatAge(new Date(2 * nowMs - ms).toISOString(), nowMs)}`;
  const text = formatRelative(row.deadline, nowMs);
  return ACTIVE.has(row.workState) ? `${text} (overdue)` : text;
}

export function TeammateTasksBody({ view, nowMs }: { view: TeammateTasksView; nowMs: number }) {
  const when = (iso: string) => Number.isFinite(Date.parse(iso)) ? formatRelative(iso, nowMs) : 'unknown';
  const c = view.counts;
  return <section className={styles.root} aria-label="Teammate tasks" data-testid="teammate-tasks">
    <strong>Teammate tasks (Dot, Instinct)</strong>
    <p className={styles.header}>
      {`${c.queued} queued · ${c.sending} sending · ${c.pending} pending · ${c.replied} replied · ${c.expired} expired · ${c.cancelled} cancelled`}
      {view.asOf && <> · as of {when(view.asOf)}</>}
    </p>
    {!view.complete && <p className={styles.notice} role="status">Some tasks could not be read.</p>}
    {view.truncated && <p className={styles.message}>Showing the newest {view.rows.length} tasks.</p>}
    {view.rows.length === 0 ? <p className={styles.message}>No tasks handed to teammates.</p> : <table aria-label="Teammate task rows">
      <thead><tr><th>Peer</th><th>Job</th><th>Kind</th><th>Repo/PRs</th><th>Work state</th><th>Since</th><th>Deadline</th></tr></thead>
      <tbody>{view.rows.map((row) => <tr key={row.jobId}>
        <td>{row.peer}</td><td>{row.jobId}</td><td>{row.kind || '—'}</td>
        <td>{row.repo || '—'}{row.prRefs.length > 0 && ` ${row.prRefs.map((n) => `#${n}`).join(' ')}`}</td>
        <td><span className={styles.healthBadge}>{LABELS[row.workState]}</span></td>
        <td><time dateTime={row.createdAt}>{when(row.createdAt)}</time></td>
        <td>{deadlineText(row, nowMs)}</td>
      </tr>)}</tbody>
    </table>}
  </section>;
}
