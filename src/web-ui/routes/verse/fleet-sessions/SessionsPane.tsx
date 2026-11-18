/**
 * The Sessions pane: every running agent session in one list (`phm sessions`).
 * Grouped by lane; a session with no output for 10 minutes is highlighted as
 * quiet. Select a session to open its live log in the Worker log pane, which
 * also holds the pause and stop controls. Built only on
 * GET /api/verse/fleet/control/live-sessions; works down to 390 px wide.
 */
import { sessionAge, sessionsByLane, SESSION_FIELDS, type LiveSessionRow, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { liveSessionsQuery, sessionsHeadline, SESSIONS_POLL_MS } from './sessions-model.js';
import styles from './fleet-sessions.module.css';

const FIELD_WORD: Readonly<Record<(typeof SESSION_FIELDS)[number], string>> = {
  lane: 'lane', model: 'model', repo: 'repo', tier: 'tier', startedAt: 'start', lastOutputAt: 'last output', computer: 'computer',
};

function output(row: LiveSessionRow): string {
  return row.lastOutputAgeSeconds === null ? 'output unknown' : `output ${sessionAge(row.lastOutputAgeSeconds)} ago`;
}
function where(row: LiveSessionRow): string {
  return row.computer === 'unknown' ? 'computer unknown' : row.thisComputer ? 'this computer' : row.computer;
}

function SessionRow({ row, onOpen }: { row: LiveSessionRow; onOpen: (job: string) => void }) {
  const reasons = SESSION_FIELDS.filter(field => row.unknown[field]);
  return <li className={styles.row} data-quiet={row.quiet ? 'true' : undefined}>
    <button type="button" className={styles.open} onClick={() => onOpen(row.job)}
      aria-label={`Open log for ${row.job}${row.quiet ? ', quiet' : ''}`}>
      <span className={styles.top}>
        <strong className={styles.job}>{row.job}</strong>
        {row.quiet && <span className={styles.quiet}>quiet</span>}
        <span className={styles.muted}>{row.status} {sessionAge(row.ageSeconds)}</span>
      </span>
      <span className={styles.facts}>
        <span>{row.repo}</span><span>{row.tier}</span><span>{row.model}</span>
        <span data-quiet={row.quiet ? 'true' : undefined}>{output(row)}</span>
        <span data-elsewhere={row.thisComputer === false ? 'true' : undefined}>{where(row)}</span>
      </span>
      {reasons.length > 0 && <span className={styles.why}>
        {reasons.map(field => `${FIELD_WORD[field]} unknown: ${row.unknown[field]}`).join('; ')}
      </span>}
    </button>
    {row.prUrl && <a className={styles.pr} href={row.prUrl} target="_blank" rel="noopener noreferrer" aria-label={`Pull request for ${row.job}`}>PR</a>}
  </li>;
}

export function SessionsView({ list, onOpen }: { list: LiveSessionsV1; onOpen: (job: string) => void }) {
  const groups = sessionsByLane(list);
  return <section className={styles.root} aria-label="Agent sessions">
    <p className={styles.headline}>{sessionsHeadline(list)}</p>
    {groups.length === 0 && <p className={styles.notice} role="status">No agent sessions running.</p>}
    {groups.map(group => <section key={group.lane} className={styles.lane} aria-label={`Lane ${group.lane}`}>
      <h3 className={styles.laneName}>
        {group.lane !== 'unknown' && <ProviderBadge of={group.lane} iconOnly size={14} />}
        {group.lane === 'unknown' ? 'Lane unknown' : group.lane}
        <span className={styles.muted}>{group.sessions.length}</span>
      </h3>
      <ul className={styles.list}>{group.sessions.map(row => <SessionRow key={row.job} row={row} onOpen={onOpen} />)}</ul>
    </section>)}
    {list.gaps.length > 0 && <ul className={styles.gaps} aria-label="Unknown">{list.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Quiet: no output for {list.quietAfterMinutes} minutes. Same list for agents: <code>phm sessions --json</code></p>
  </section>;
}

export function SessionsPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const read = useQuery(liveSessionsQuery, { enabled: visible, freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: visible });
  // The Worker log pane is the existing live tail, with pause and stop beside it.
  const open = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  if (read.data === undefined && !read.error) return <div className={styles.root} role="status">Reading sessions…</div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status">Sessions unavailable right now. It retries every few seconds.</p></div>;
  return <>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last list, which may be stale.</p>}
    <SessionsView list={read.data} onOpen={open} />
  </>;
}
