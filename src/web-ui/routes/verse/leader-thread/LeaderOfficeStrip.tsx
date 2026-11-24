import type { LeaderOfficePanelView } from './leader-office-model.js';
import styles from './leader-thread.module.css';

/** Priorities and org beside the Leader conversation. */
export function LeaderOfficeStrip({ view }: { view: LeaderOfficePanelView | null }) {
  if (!view) return <section aria-label="Leader office"><p className={styles.unknown}>Org and priorities unavailable.</p></section>;
  return <section className={styles.office} aria-label="Leader office">
    <div>
      <h3>Priorities</h3>
      {view.priorities.length
        ? <ul aria-label="Priorities">{view.priorities.map((row) => <li key={row.rq}>
          {row.rq} · {row.owner} · {row.status}{row.due ? ` · due ${row.due}` : ''}{row.outcome ? ` · ${row.outcome}` : ''}
        </li>)}</ul>
        : <p className={styles.quiet}>No open work.</p>}
    </div>
    <div>
      <h3>Org</h3>
      <ul aria-label="Org">{view.roles.map((role) => <li key={role.id}>{role.title} · {role.owner} · {role.lane}</li>)}</ul>
    </div>
    {view.latestReply ? <p className={styles.latestReply}>Latest reply: {view.latestReply}</p> : null}
  </section>;
}
