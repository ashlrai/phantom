import type { LeaderOfficePanelView } from './leader-office-model.js';

/** Priorities and org beside the Leader conversation. */
export function LeaderOfficeStrip({ view }: { view: LeaderOfficePanelView | null }) {
  if (!view) return <section aria-label="Leader office"><p>Org and priorities unavailable.</p></section>;
  return <section aria-label="Leader office">
    <h3>Priorities</h3>
    {view.priorities.length
      ? <ul aria-label="Priorities">{view.priorities.map((row) => <li key={row.rq}>
        {row.rq} · {row.owner} · {row.status}{row.due ? ` · due ${row.due}` : ''}{row.outcome ? ` · ${row.outcome}` : ''}
      </li>)}</ul>
      : <p>No open work.</p>}
    <h3>Org</h3>
    <ul aria-label="Org">{view.roles.map((role) => <li key={role.id}>{role.title} · {role.owner} · {role.lane}</li>)}</ul>
    {view.latestReply ? <p>Latest reply: {view.latestReply}</p> : null}
  </section>;
}
