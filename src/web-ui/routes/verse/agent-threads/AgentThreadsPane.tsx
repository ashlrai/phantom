/**
 * The Agent threads pane: every agent session as a conversation, on one screen. The list on the left is one row
 * per session (the leader first, then quiet, running and failed ones) with its state, when it last spoke and its
 * last message. Selecting one opens its thread: a summary assembled from the records, then the brief it was
 * given, its recorded steps, what it ran and changed, its notes, the bus messages about it and the last thing it
 * said. The leader's thread shows its newest replies and opens the Leader chat. Read-only; pause, stop and steer
 * stay in the Worker log, one key away. Keys: J/K or arrows move, Enter opens the full log, / filters.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { jobActivityQuery } from '../fleet-job-log/job-activity-queries.js';
import { JOB_ID_RE } from '../fleet-job-log/job-id.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { agentMessagesQuery } from '../fleet-messages/messages-query.js';
import { liveSessionsQuery, sessionsHeadline, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import { leaderRepliesQuery, replyWhen } from '../home/LeaderRepliesCard.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { spoke } from '../../../../core/fleet/live-sessions.js';
import { agentThreads, stateWord, stepThread, threadBubbles, threadFacts, threadSummary, type AgentThread, type ThreadBubble } from './agent-threads-model.js';
import styles from './agent-threads.module.css';

const THREAD_POLL_MS = 5_000, BUS_POLL_MS = 15_000, LEADER_REPLIES = 5;
/** A query for a session with no job never runs; the key only keeps the hook order stable. */
const NO_JOB = 'no-job';

function Bubble({ bubble }: { bubble: ThreadBubble }) {
  return <li className={styles.bubble} data-side={bubble.side}>
    <span className={styles.meta}><strong>{bubble.label}</strong>{bubble.when !== '' && <span>{bubble.when}</span>}</span>
    {bubble.text === '' ? null : bubble.format === 'markdown' ? <div className={styles.body}><MessageMarkdown text={bubble.text} /></div>
      : bubble.format === 'mono' ? <pre className={styles.body}>{bubble.text}</pre> : <p className={styles.body}>{bubble.text}</p>}
  </li>;
}

function ThreadView({ thread, visible, onOpenLog, onOpenLeader, onBack }: {
  thread: AgentThread; visible: boolean; onOpenLog: (job: string) => void; onOpenLeader: () => void; onBack: () => void;
}) {
  const { node, row } = thread, leader = node.kind === 'leader';
  const job = node.jobId !== null && JOB_ID_RE.test(node.jobId) ? node.jobId : null;
  const activityQuery = useMemo(() => jobActivityQuery(job ?? NO_JOB), [job]);
  const activity = useQuery(activityQuery, { enabled: visible && job !== null, freshMs: 0 });
  const refetchActivity = useRefetch(activityQuery);
  usePollWhileVisible(refetchActivity, THREAD_POLL_MS, { enabled: visible && job !== null });
  const bus = useQuery(agentMessagesQuery, { enabled: visible, freshMs: BUS_POLL_MS });
  const refetchBus = useRefetch(agentMessagesQuery);
  usePollWhileVisible(refetchBus, BUS_POLL_MS, { enabled: visible });
  const repliesQuery = useMemo(() => leaderRepliesQuery(LEADER_REPLIES), []);
  const replies = useQuery(repliesQuery, { enabled: visible && leader });

  // A session with no job has no activity read: that is "none recorded", not "still reading".
  const recorded = job === null ? null : activity.data;
  const bubbles = useMemo(() => {
    const said = leader && replies.data?.schema === 'leader.replies.v1' && Array.isArray(replies.data.replies)
      ? [...replies.data.replies].reverse().map((reply, index): ThreadBubble => ({
        key: `reply:${index}`, side: 'agent', label: 'Leader', when: replyWhen(reply.at), text: reply.text, format: 'plain' }))
      : [];
    return [...said, ...threadBubbles(thread, recorded, bus.data?.messages ?? [])];
  }, [thread, recorded, bus.data, leader, replies.data]);
  const logRef = useRef<HTMLOListElement>(null);
  // A conversation reads from its end: a new thread, or a new message in this one, lands in view.
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [node.id, bubbles.length]);

  const reading = job !== null && activity.data === undefined && !activity.error;
  const notes = [
    activity.error ? 'The thread could not refresh; it may be stale.' : null,
    bus.error || bus.data === null || (bus.data && bus.data.source !== 'available') ? 'Bus messages unavailable.' : null,
    leader && replies.error ? 'Leader replies unavailable.' : null,
  ].filter((note): note is string => note !== null);
  return <section className={styles.thread} aria-label={`Thread with ${node.id}`}>
    <header className={styles.threadHead}>
      <button type="button" className={styles.back} onClick={onBack}>Sessions</button>
      <h2 className={styles.name}>{node.lane !== 'unknown' && <ProviderBadge of={node.lane} iconOnly size={14} />}{node.id}</h2>
      <span className={styles.state} data-state={thread.state}>{stateWord(thread)}</span>
      <span className={styles.actions}>
        {row?.prUrl && <a href={row.prUrl} target="_blank" rel="noopener noreferrer">Pull request</a>}
        {leader && <button type="button" className={styles.tool} onClick={onOpenLeader}>Open Leader chat</button>}
        {job !== null && <button type="button" className={styles.tool} onClick={() => onOpenLog(job)}>Open full log <kbd>↵</kbd></button>}
      </span>
    </header>
    <div className={styles.summary} aria-label="Summary">
      <h3>Summary</h3>
      <ul>{threadSummary(thread, recorded).map(line => <li key={line}>{line}</li>)}</ul>
      {reading && <p role="status">Reading the thread…</p>}
      {notes.map(note => <p key={note} role="status" data-tone="unknown">{note}</p>)}
    </div>
    <ol ref={logRef} className={styles.log} role="log" aria-label={`Messages with ${node.id}`} tabIndex={0}>
      {bubbles.length === 0 && !reading
        ? <li className={styles.none}>{leader ? 'No leader replies recorded yet.' : 'Nothing is recorded for this session yet.'}</li>
        : bubbles.map(bubble => <Bubble key={bubble.key} bubble={bubble} />)}
    </ol>
  </section>;
}

export function AgentThreadsPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const read = useQuery(liveSessionsQuery, { enabled: visible, freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: visible });
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => (read.data ? agentThreads(read.data) : []), [read.data]);
  const threads = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle === '' ? all : all.filter(({ node }) => [node.id, node.agent, node.lane, node.repo, node.model, node.lastMessage ?? ''].join(' ').toLowerCase().includes(needle));
  }, [all, filter]);
  const current = threads.find(thread => thread.node.id === selected) ?? threads[0] ?? null;

  if (read.data === undefined && !read.error) return <div className={styles.root}><p className={styles.notice} role="status" aria-busy="true">Reading sessions…</p></div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status" data-tone="unknown">Sessions unavailable right now. It retries every few seconds.</p></div>;

  const openLog = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  const select = (id: string | null, focus = false) => {
    if (id === null) return;
    setSelected(id);
    if (focus) [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-thread]') ?? [])].find(row => row.dataset.thread === id)?.focus();
  };
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      if (typing && filter !== '') setFilter(''); else if (open) setOpen(false); else return;
      event.preventDefault();
    } else if (event.key === 'ArrowDown' || (!typing && event.key === 'j')) { event.preventDefault(); select(stepThread(threads, current?.node.id ?? null, 1), !typing); }
    else if (event.key === 'ArrowUp' || (!typing && event.key === 'k')) { event.preventDefault(); select(stepThread(threads, current?.node.id ?? null, -1), !typing); }
    else if (!typing && event.key === '/') { event.preventDefault(); filterRef.current?.focus(); }
    else if (event.key === 'Enter' && current && (typing || (event.target as HTMLElement).dataset.thread !== undefined)) {
      event.preventDefault();
      if (current.node.jobId !== null && JOB_ID_RE.test(current.node.jobId) && !typing) openLog(current.node.jobId); else { select(current.node.id); setOpen(true); }
    }
  }

  return <div ref={rootRef} className={styles.root} data-open={open ? 'true' : 'false'} onKeyDown={onKeyDown}>
    <nav className={styles.list} aria-label="Agent sessions">
      {all.length > 0 && <p className={styles.headline}>{sessionsHeadline(read.data)}</p>}
      {read.error ? <p className={styles.notice} role="status" data-tone="unknown">Refresh failed; showing the last list, which may be stale.</p> : null}
      <input ref={filterRef} className={styles.filter} type="search" aria-label="Filter sessions" placeholder="Filter sessions  /" value={filter} onChange={event => setFilter(event.target.value)} />
      {threads.length === 0 ? <p className={styles.notice} role="status">{all.length === 0 ? 'No agent sessions running.' : `No session matches “${filter.trim()}”.`}</p>
        : <ul aria-label="Threads">{threads.map(thread => {
          const { node } = thread;
          return <li key={node.id}>
            <button type="button" className={styles.row} data-thread={node.id} data-state={thread.state} aria-current={current === thread ? 'true' : undefined}
              aria-label={`${node.id}, ${stateWord(thread)}, ${spoke(node)}`} onClick={() => { select(node.id); setOpen(true); }}>
              <span className={styles.rowTop}>
                {node.lane !== 'unknown' && <ProviderBadge of={node.lane} iconOnly size={14} />}
                <strong>{node.id}</strong>
                <span className={styles.state} data-state={thread.state}>{thread.state === 'running' ? spoke(node) : `${stateWord(thread)} · ${spoke(node)}`}</span>
              </span>
              <span className={styles.facts}>{threadFacts(thread)}{thread.parent && thread.parent !== 'leader' ? ` · helps ${thread.parent}` : ''}</span>
              <span className={styles.said} data-unknown={node.lastMessage === null || undefined}>{node.lastMessage ?? 'Last message unknown'}</span>
            </button>
          </li>;
        })}</ul>}
      {read.data.gaps.length > 0 && <p className={styles.notice} data-tone="unknown">Unknown: {read.data.gaps[0]}{read.data.gaps.length > 1 ? ` (and ${read.data.gaps.length - 1} more in Sessions)` : ''}</p>}
    </nav>
    {current ? <ThreadView key={current.node.id} thread={current} visible={visible} onOpenLog={openLog}
      onOpenLeader={() => host.openPane('leader-thread')} onBack={() => setOpen(false)} />
      : <section className={styles.thread} aria-label="Thread"><p className={styles.none}>{all.length === 0 ? 'Each session gets a thread here as soon as it starts.' : 'Select a session to read its thread.'}</p></section>}
  </div>;
}
