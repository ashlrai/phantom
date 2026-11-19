/**
 * The Sessions pane: every agent session as one tree (`phm sessions`): leader,
 * then workers, then their subagents, running first. Each row shows model,
 * repo, when it last spoke and its last message; a session with no output for
 * 10 minutes is highlighted as quiet. Select a session to open its messages in
 * the Worker log pane, which also holds the pause and stop controls; Thread on
 * a row reads that session as a conversation here (SessionThread.tsx). The list
 * is built only on GET /api/verse/fleet/control/live-sessions; works down to 390 px wide.
 */
import { useState } from 'react';
import { flatTree, spoke, SESSION_FIELDS, type LiveSessionRow, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { liveSessionsQuery, sessionsHeadline, SESSIONS_POLL_MS } from './sessions-model.js';
import { SessionThread } from './SessionThread.js';
import styles from './fleet-sessions.module.css';

const FIELD_WORD: Readonly<Record<(typeof SESSION_FIELDS)[number], string>> = {
  lane: 'lane', model: 'model', repo: 'repo', tier: 'tier', startedAt: 'start', lastOutputAt: 'last output', computer: 'computer',
};

/** One tree row. `row` is the running session's entry in `sessions[]` (quiet, computer, PR, unknown reasons), when it has one. */
function SessionRow({ node, depth, row, onOpen, onOpenLeader, onThread }: {
  node: SessionNode; depth: number; row: LiveSessionRow | undefined; onOpen: (job: string) => void; onOpenLeader?: () => void; onThread?: (id: string) => void;
}) {
  const indent = { marginLeft: `calc(${Math.min(depth, 4)} * var(--space-3))` };
  if (node.kind === 'unknown-parent') return <li className={styles.group} style={indent}>Unknown parent <span className={styles.muted}>{node.counts.below}</span></li>;
  const reasons = SESSION_FIELDS.filter(field => row?.unknown[field]);
  const body = <>
    <span className={styles.top}>
      {node.kind === 'worker' && node.lane !== 'unknown' && <ProviderBadge of={node.lane} iconOnly size={14} />}
      <strong className={styles.job}>{node.id}</strong>
      {row?.quiet && <span className={styles.quiet}>quiet</span>}
      <span className={styles.muted} data-state={node.state}>{node.state === 'unknown' ? 'state unknown' : node.state}</span>
    </span>
    <span className={styles.facts}>
      <span>{node.kind}</span><span>{node.model === 'unknown' ? 'model unknown' : node.model}</span><span>{node.repo === 'unknown' ? 'repo unknown' : node.repo}</span>
      <span data-quiet={row?.quiet ? 'true' : undefined}>{spoke(node)}</span>
      {row && <span data-elsewhere={row.thisComputer === false ? 'true' : undefined}>{row.computer === 'unknown' ? 'computer unknown' : row.thisComputer ? 'this computer' : row.computer}</span>}
      {node.counts.below > 0 && <span>{node.counts.running} of {node.counts.below} below running</span>}
    </span>
    <span className={styles.message}>{node.lastMessage ?? 'Last message unknown'}</span>
    {reasons.length > 0 && <span className={styles.why}>
      {reasons.map(field => `${FIELD_WORD[field]} unknown: ${row!.unknown[field]}`).join('; ')}
    </span>}
  </>;
  return <li className={styles.row} style={indent} data-quiet={row?.quiet ? 'true' : undefined} data-kind={node.kind}>
    {node.kind === 'leader' && onOpenLeader ? <button type="button" className={styles.open} onClick={onOpenLeader} aria-label="Open the Leader chat">{body}</button>
      : node.jobId === null ? <div className={styles.open} aria-label={`${node.id}, ${node.kind}`}>{body}</div>
      : <button type="button" className={styles.open} onClick={() => onOpen(node.jobId!)}
        aria-label={`Open messages for ${node.id}${row?.quiet ? ', quiet' : ''}`}>{body}</button>}
    {onThread && <button type="button" className={styles.thread} onClick={() => onThread(node.id)} aria-label={`Read ${node.id} as a conversation`}>Thread</button>}
    {row?.prUrl && <a className={styles.pr} href={row.prUrl} target="_blank" rel="noopener noreferrer" aria-label={`Pull request for ${node.id}`}>PR</a>}
  </li>;
}

/**
 * `onOpenLeader`, when given, makes the leader's row open the Leader chat (its conversation lives there, not in a worker log).
 * `onThread`, when given, adds a Thread button to every session row: that session read as a conversation, in this pane.
 */
export function SessionsView({ list, onOpen, onOpenLeader, onThread }: {
  list: LiveSessionsV1; onOpen: (job: string) => void; onOpenLeader?: () => void; onThread?: (id: string) => void;
}) {
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  const tree = flatTree(list.tree.roots);
  return <section className={styles.root} aria-label="Agent sessions">
    <p className={styles.headline}>{sessionsHeadline(list)}</p>
    {tree.length === 0 ? <p className={styles.notice} role="status">No agent sessions running.</p>
      : <ul className={styles.list} aria-label="Session tree">{tree.map(({ node, depth }) =>
        <SessionRow key={node.id} node={node} depth={depth} row={node.jobId === null ? undefined : rows.get(node.jobId)} onOpen={onOpen} onOpenLeader={onOpenLeader} onThread={onThread} />)}</ul>}
    {list.gaps.length > 0 && <ul className={styles.gaps} aria-label="Unknown">{list.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Quiet: no output for {list.quietAfterMinutes} minutes. Finished sessions stay for an hour. Same tree for agents: <code>phm sessions --json</code></p>
  </section>;
}

export function SessionsPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const read = useQuery(liveSessionsQuery, { enabled: visible, freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: visible });
  // The Worker log pane is the existing live tail, with pause and stop beside it.
  const open = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  // The session being read as a conversation; the list comes back with Back or Escape.
  const [threadId, setThreadId] = useState<string | null>(null);
  if (threadId !== null) return <SessionThread id={threadId} visible={visible} onBack={() => setThreadId(null)} onOpenLog={open} />;
  if (read.data === undefined && !read.error) return <div className={styles.root} role="status">Reading sessions…</div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status">Sessions unavailable right now. It retries every few seconds.</p></div>;
  return <>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last list, which may be stale.</p>}
    <SessionsView list={read.data} onOpen={open} onOpenLeader={() => host.openPane('leader-thread')} onThread={setThreadId} />
  </>;
}
