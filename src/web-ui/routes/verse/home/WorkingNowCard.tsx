/**
 * Home's Working now card: what each agent session is doing, without opening the Sessions pane. Quiet sessions lead
 * (they are the ones to look at), then the ones that spoke most recently, then any that failed in the last hour.
 * Each row opens that session's messages. Built only on the same `phm sessions --json` list (fleet.live-sessions.v1)
 * the Sessions pane reads, so both share one cached read. Read-only. A fact the list does not hold reads "unknown".
 */
import { flatTree, spoke, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { liveSessionsQuery, sessionsHeadline } from '../fleet-sessions/sessions-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import home from './home.module.css';
import styles from './working-now.module.css';

/** Home is a glance; the Sessions pane holds the whole tree. */
export const WORKING_NOW_LIMIT = 6;
const POLL_MS = 15_000;

export interface WorkingRow { node: SessionNode; quiet: boolean }

/** Workers that are running, or failed in the tree's last hour: quiet first, then running, then failed. The tree's own order (most recent first) is kept within each. */
export function workingRows(list: LiveSessionsV1): WorkingRow[] {
  const quiet = new Set(list.sessions.filter(row => row.quiet === true).map(row => row.job));
  const rank = (row: WorkingRow) => (row.quiet ? 0 : row.node.state === 'running' ? 1 : 2);
  return flatTree(list.tree.roots).map(({ node }) => node)
    .filter(node => node.kind === 'worker' && (node.state === 'running' || node.state === 'failed'))
    .map((node, index) => ({ index, row: { node, quiet: node.state === 'running' && node.jobId !== null && quiet.has(node.jobId) } }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}

/** Only a narrowed live-sessions list is a list; anything else (an older server, an error body) hides the card. */
function listOf(data: unknown): LiveSessionsV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const list = data as Partial<LiveSessionsV1>;
  return list.schema === 'fleet.live-sessions.v1' && Array.isArray(list.sessions) && Array.isArray(list.tree?.roots) ? list as LiveSessionsV1 : null;
}

function Row({ row: { node, quiet }, onOpenJob }: { row: WorkingRow; onOpenJob: (job: string) => void }) {
  const state = quiet ? 'quiet' : node.state;
  const body = <>
    <span className={styles.top}>
      {node.lane !== 'unknown' && <ProviderBadge of={node.lane} iconOnly size={14} />}
      <strong className={styles.job}>{node.id}</strong>
      <span className={styles.fact}>{node.repo === 'unknown' ? 'repo unknown' : node.repo}</span>
      {/* The words carry the state; the mark beside them only repeats it. */}
      <span className={styles.when} data-state={state}>{state === 'running' ? '' : `${state} · `}{spoke(node)}</span>
    </span>
    <span className={styles.said} data-unknown={node.lastMessage === null || undefined}>{node.lastMessage ?? 'Last message unknown'}</span>
    {node.counts.below > 0 && <span className={styles.fact}>{node.counts.running} of {node.counts.below} helpers running</span>}
  </>;
  return <li data-state={state}>
    {node.jobId === null ? <div className={styles.session}>{body}</div>
      : <button type="button" className={styles.session} aria-label={`Open messages for ${node.id}${quiet ? ', quiet' : ''}`} onClick={() => onOpenJob(node.jobId!)}>{body}</button>}
  </li>;
}

export function WorkingNowCard({ visible = true, onOpenJob, onOpenSessions }: { visible?: boolean; onOpenJob: (job: string) => void; onOpenSessions: () => void }) {
  const read = useQuery(liveSessionsQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refresh, POLL_MS, { enabled: visible });
  const list = listOf(read.data);
  const failed = Boolean(read.error) || read.status === 'error';
  // Before the first read, or any other payload, the card stays hidden rather than claim an empty fleet.
  if (!list && !failed) return null;
  const rows = list ? workingRows(list) : [];
  const more = rows.length - WORKING_NOW_LIMIT;
  return <section className={home.card} aria-label="Working now">
    <h3>Working now</h3>
    {failed ? <p role="status" data-warn>{list ? 'Could not refresh. Showing the last list, which may be stale.' : 'Unknown: the sessions could not be read.'}</p> : null}
    {list ? <>
      <p>{sessionsHeadline(list)}</p>
      {rows.length > 0 && <ul className={styles.sessions} aria-label="Sessions working now">
        {rows.slice(0, WORKING_NOW_LIMIT).map(row => <Row key={row.node.id} row={row} onOpenJob={onOpenJob} />)}
      </ul>}
      {more > 0 && <p className={styles.fact}>and {more} more in Sessions.</p>}
      {list.gaps.length > 0 && <p data-unknown>Unknown: {list.gaps[0]}{list.gaps.length > 1 ? ` (and ${list.gaps.length - 1} more in Sessions)` : ''}</p>}
    </> : null}
    <button type="button" className={home.action} onClick={onOpenSessions}>Open Sessions</button>
  </section>;
}
