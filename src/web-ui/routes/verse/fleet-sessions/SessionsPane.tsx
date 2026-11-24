/**
 * The Sessions pane: every agent session as one tree (`phm sessions`): leader,
 * then workers, then their subagents, running first. Each row shows model,
 * repo, when it last spoke and its last message; a session with no output for
 * 10 minutes is highlighted as quiet. Select a session to open its messages in
 * the Worker log pane, which also holds the pause and stop controls; Thread on
 * a row reads that session as a conversation here (SessionThread.tsx). The list
 * is built only on GET /api/verse/fleet/control/live-sessions; works down to 390 px wide.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { spoke, SESSION_FIELDS, type LiveSessionRow, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { Input } from '../../../components/primitives/Input.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { filterSessionTree, liveSessionsQuery, SESSION_SCOPES, sessionScopeCounts, sessionsHeadline, SESSIONS_POLL_MS, type SessionScope } from './sessions-model.js';
import { SessionThread } from './SessionThread.js';
import styles from './fleet-sessions.module.css';

const FIELD_WORD: Readonly<Record<(typeof SESSION_FIELDS)[number], string>> = {
  lane: 'lane', model: 'model', repo: 'repo', tier: 'tier', startedAt: 'start', lastOutputAt: 'last output', computer: 'computer',
};

const SCOPE_WORD: Readonly<Record<SessionScope, string>> = { all: 'All', running: 'Running', quiet: 'Quiet', failed: 'Failed' };

/** One tree row. `row` is the running session's entry in `sessions[]` (quiet, computer, PR, unknown reasons), when it has one. */
function SessionRow({ node, depth, row, context, onOpen, onOpenLeader, onThread }: {
  node: SessionNode; depth: number; context: boolean; row: LiveSessionRow | undefined; onOpen: (job: string) => void; onOpenLeader?: () => void; onThread?: (id: string) => void;
}) {
  const indent = { marginLeft: `calc(${Math.min(depth, 4)} * var(--space-3))` };
  if (node.kind === 'unknown-parent') return <li className={styles.group} style={indent}>Unknown parent <span className={styles.muted}>{node.counts.below}</span></li>;
  const reasons = SESSION_FIELDS.filter(field => row?.unknown[field]);
  const body = <>
    <span className={styles.top}>
      <span className={styles.dot} data-dot={row?.quiet ? 'quiet' : node.state} aria-hidden="true" />
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
  return <li className={styles.row} style={indent} data-quiet={row?.quiet ? 'true' : undefined} data-kind={node.kind} data-context={context ? 'true' : undefined}>
    {node.kind === 'leader' && onOpenLeader ? <button type="button" className={styles.open} data-session-open="" onClick={onOpenLeader} aria-label="Open the Leader chat">{body}</button>
      : node.jobId === null ? <div className={styles.open} aria-label={`${node.id}, ${node.kind}`}>{body}</div>
      : <button type="button" className={styles.open} data-session-open="" onClick={() => onOpen(node.jobId!)}
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
  const [scope, setScope] = useState<SessionScope>('all');
  const [query, setQuery] = useState('');
  const root = useRef<HTMLElement>(null);
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  const counts = sessionScopeCounts(list);
  const { rows: tree, matches } = filterSessionTree(list, scope, query);
  const narrowed = scope !== 'all' || query.trim() !== '';
  const clear = () => { setScope('all'); setQuery(''); };
  const filterBox = () => root.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;

  /** `/` focuses the filter; ↑ ↓ (j k outside the filter) walk the sessions, with the filter as the stop above the first one. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement, typing = target instanceof HTMLInputElement;
    if (target.getAttribute('role') === 'radio') return; // the scope control owns its own arrows
    if (event.key === '/' && !typing) { event.preventDefault(); filterBox()?.focus(); return; }
    if (event.key === 'Escape' && typing && query !== '') { event.preventDefault(); event.stopPropagation(); setQuery(''); return; }
    const step = event.key === 'ArrowDown' || (!typing && event.key === 'j') ? 1 : event.key === 'ArrowUp' || (!typing && event.key === 'k') ? -1 : 0;
    const edge = typing ? null : event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : null;
    if ((step === 0 && edge === null) || (typing && step < 0)) return;
    const opens = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-session-open]') ?? []);
    const next = edge === 'first' ? 0 : edge === 'last' ? opens.length - 1 : opens.indexOf(document.activeElement as HTMLButtonElement) + step;
    event.preventDefault();
    if (next < 0) filterBox()?.focus(); else opens[Math.min(next, opens.length - 1)]?.focus();
  };

  // The "unknown parent" group is a heading, not a session, so the scope total is the test for an empty fleet.
  const none = counts.all === 0;
  return <section ref={root} className={styles.root} aria-label="Agent sessions" onKeyDown={none ? undefined : onKeyDown}>
    <p className={styles.headline}>{sessionsHeadline(list)}</p>
    {none && <p className={styles.notice} role="status">No agent sessions running.</p>}
    {!none && <div className={styles.toolbar}>
      <Segmented size="sm" aria-label="Show sessions" value={scope} onChange={setScope} options={SESSION_SCOPES.map(value => ({
        value, label: <>{SCOPE_WORD[value]} <span className={styles.count}>{counts[value]}</span></>,
        ariaLabel: `${SCOPE_WORD[value]}, ${counts[value]} ${counts[value] === 1 ? 'session' : 'sessions'}` }))} />
      <Input className={styles.search} size="sm" type="search" aria-label="Filter sessions" aria-keyshortcuts="/" placeholder="Filter by id, repo, model or message"
        autoComplete="off" spellCheck={false} value={query} onChange={event => setQuery(event.target.value)} />
    </div>}
    {!none && narrowed && <p className={styles.notice} role="status">
      {matches === 0 ? 'No sessions match.' : `Showing ${matches} of ${counts.all} ${counts.all === 1 ? 'session' : 'sessions'}.`}{' '}
      <button type="button" className={styles.clear} onClick={clear}>Show all</button>
    </p>}
    {tree.length > 0 && <ul className={styles.list} aria-label="Session tree">{tree.map(({ node, depth, context }) =>
      <SessionRow key={node.id} node={node} depth={depth} context={context} row={node.jobId === null ? undefined : rows.get(node.jobId)} onOpen={onOpen} onOpenLeader={onOpenLeader} onThread={onThread} />)}</ul>}
    {list.gaps.length > 0 && <ul className={styles.gaps} aria-label="Unknown">{list.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    {!none && <p className={styles.keys}><kbd>/</kbd> filter <kbd>↑</kbd> <kbd>↓</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> clear</p>}
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
