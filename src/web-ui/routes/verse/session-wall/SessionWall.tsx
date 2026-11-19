/**
 * The Conversations pane: every agent session on one screen, each as a short
 * conversation (who it is, a summary assembled from the records, its newest
 * messages), from one request. Opening a card shows that session's whole
 * conversation in the pane: said to it on the right, said and done by it on
 * the left, recorded steps in the centre. Writing to a running session hands
 * `@RQ-…` to the Leader's reply box, the one place a message is sent from.
 * Arrow keys (or J and K) move between cards, Enter opens, Esc comes back.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { clockTime } from '../leader/thread-model.js';
import { setLeaderDraft } from '../leader-thread/leader-draft-store.js';
import { subscribeWallSelection, takeRequestedWallSession } from './wall-selection.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { aimableJob, openThreadQuery, routedJobs, sessionWallQuery, sourcesLine, stateCounts, STATE_WORD, WALL_POLL_MS, WALL_STATES, wallFailure, wallHeadline,
  type OpenThread, type SessionWallRead, type WallEntry, type WallFailure, type WallMessage, type WallSession, type WallState } from './session-wall-model.js';
import styles from './session-wall.module.css';

const spoke = (session: WallSession) => (session.lastMessageAgeSeconds === null ? 'last spoke unknown' : `spoke ${sessionAge(session.lastMessageAgeSeconds)} ago`);

function Identity({ session }: { session: WallSession }) {
  return <>
    {session.kind === 'worker' && session.lane !== 'unknown' && <ProviderBadge of={session.lane} iconOnly size={14} />}
    <strong className={styles.id}>{session.id}</strong>
    <span className={styles.state} data-state={session.state}>{STATE_WORD[session.state]}</span>
    <span className={styles.muted}>{spoke(session)}</span>
  </>;
}

/** One session on the wall. The card is a single button, so its text stays plain; the opened conversation renders markdown. */
function Card({ entry, onOpen }: { entry: WallEntry; onOpen: (id: string) => void }) {
  const { session } = entry, summaryId = useId();
  const earlier = entry.messageCount - entry.messages.length;
  return <li className={styles.card} data-state={session.state}>
    <button type="button" className={styles.open} data-card={session.id} onClick={() => onOpen(session.id)}
      aria-label={`${session.id}, ${STATE_WORD[session.state]}`} aria-describedby={summaryId}>
      <span className={styles.top}><Identity session={session} /></span>
      <span className={styles.facts}>
        <span>{session.kind}</span><span>{session.model === 'unknown' ? 'model unknown' : session.model}</span>
        <span>{session.repo === 'unknown' ? 'repo unknown' : session.repo}</span>
        {session.kind === 'subagent' && <span>{session.parentId ? `helps ${session.parentId}` : 'parent unknown'}</span>}
      </span>
      <span id={summaryId} className={styles.summary}>{entry.summary.length > 0 ? entry.summary.join(' ') : 'Summary unknown: the read returned none.'}</span>
      <span className={styles.lines}>
        {earlier > 0 && <span className={styles.record}>{earlier} earlier</span>}
        {entry.messages.map(message => message.side === 'record'
          ? <span key={message.key} className={styles.record} data-kind={message.kind}>{message.label}{message.text && `: ${message.text.replace(/\s*\n\s*/g, ' · ')}`}</span>
          : <span key={message.key} className={styles.entry} data-side={message.side}>
            <span className={styles.label}>{message.label}{message.at && ` · ${clockTime(message.at)}`}</span>
            <span className={styles.bubble}>{message.text}</span>
          </span>)}
        {entry.messageCount === 0 && <span className={styles.record}>Nothing is recorded for this session yet.</span>}
      </span>
    </button>
  </li>;
}

const cardsIn = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLButtonElement>('button[data-card]') ?? [])];

/** `focusId` is the session to put the keyboard back on (the one just closed). */
export function WallView({ read, onOpen, focusId = null }: { read: SessionWallRead; onOpen: (id: string) => void; focusId?: string | null }) {
  const [only, setOnly] = useState<WallState | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const counts = stateCounts(read.entries);
  // A filter whose last session has changed state falls back to everything rather than showing an empty wall.
  const filter = only !== null && counts[only] > 0 ? only : null;
  const shown = filter === null ? read.entries : read.entries.filter(entry => entry.session.state === filter);
  useEffect(() => { if (focusId !== null) cardsIn(list.current).find(card => card.dataset.card === focusId)?.focus(); }, [focusId]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const all = cardsIn(list.current), at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'j' ? Math.min(at + 1, all.length - 1)
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'k' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (to < 0 || !all[to]) return;
    event.preventDefault();
    all[to].focus();
  };
  return <section className={styles.root} aria-label="Every session as a conversation">
    <p className={styles.headline}>{wallHeadline(read)}</p>
    {read.entries.length > 0 && <div className={styles.filters} role="group" aria-label="Show sessions by state">
      <button type="button" className={styles.filter} aria-pressed={filter === null} onClick={() => setOnly(null)}>All <span>{read.entries.length}</span></button>
      {WALL_STATES.filter(state => counts[state] > 0).map(state =>
        <button key={state} type="button" className={styles.filter} data-state={state} aria-pressed={filter === state}
          onClick={() => setOnly(filter === state ? null : state)}>{STATE_WORD[state]} <span>{counts[state]}</span></button>)}
    </div>}
    {read.entries.length === 0
      ? <p className={styles.empty} role="status">{read.total ? 'The list holds sessions, but none came back as a conversation.' : 'No agent sessions right now. Each one appears here as the fleet starts it.'}</p>
      : <ul ref={list} className={styles.wall} aria-label="Conversations" onKeyDown={onKeyDown}>
        {shown.map(entry => <Card key={entry.session.id} entry={entry} onOpen={onOpen} />)}
      </ul>}
    {read.gaps.length > 0 && <ul className={styles.gaps} aria-label="Not shown">{read.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Updated {clockTime(read.generatedAt) || 'at an unknown time'}. Summaries are assembled from the records, not written by a model. Same read for agents: <code>phm sessions threads --json</code></p>
  </section>;
}

function Bubble({ message }: { message: WallMessage }) {
  const at = message.at ? clockTime(message.at) : '';
  if (message.kind === 'routing') {
    // Where the Leader sent one of Mason's messages: a row per job, in the server's words, under the message it follows.
    return <li className={styles.routing} data-side="record" data-kind="routing">
      <strong>{message.label}</strong>
      <ul className={styles.routes} aria-label={message.label}>
        {routedJobs(message.text).map(job => <li key={job.text}>
          {job.text}{job.pr && <> <a className={styles.pr} href={job.pr.url} target="_blank" rel="noopener noreferrer" aria-label={`Pull request ${job.pr.number}`}>#{job.pr.number}</a></>}
        </li>)}
      </ul>
    </li>;
  }
  if (message.side === 'record') {
    return <li className={styles.record} data-side="record">
      <strong>{message.label}</strong>{message.text && <span> {message.text}</span>}{at && <time dateTime={message.at!}> {at}</time>}
    </li>;
  }
  return <li className={styles.entry} data-side={message.side} data-kind={message.kind}>
    <span className={styles.label}>{message.label}{at && <> · <time dateTime={message.at!}>{at}</time></>}</span>
    <div className={styles.bubble}>
      {message.format === 'markdown' ? <MessageMarkdown text={message.text} />
        : message.format === 'mono' ? <pre className={styles.mono}>{message.text}</pre>
        : <p className={styles.plain}>{message.text}</p>}
    </div>
  </li>;
}

function Fault({ failure, onRetry, children }: { failure: WallFailure; onRetry: () => void; children?: ReactNode }) {
  return <div className={styles.fault} role="alert" data-kind={failure.kind}>
    <p className={styles.plain}>{failure.text}</p>
    <span className={styles.actions}>
      {failure.kind !== 'unsupported' && <button type="button" className={styles.link} onClick={onRetry}>Try again</button>}
      {children}
    </span>
  </div>;
}

export function ThreadBody({ thread }: { thread: OpenThread }) {
  return <>
    <div className={styles.brief} aria-label="Summary">
      <span className={styles.briefTitle}>Summary <span className={styles.muted}>from the records, as of {clockTime(thread.generatedAt) || 'an unknown time'}</span></span>
      {thread.summary.length === 0 ? <p className={styles.plain}>Summary unknown: the read returned none.</p>
        : thread.summary.map(line => <p key={line} className={styles.plain}>{line}</p>)}
    </div>
    {thread.messages.length === 0 ? <p className={styles.empty} role="status">Nothing is recorded for {thread.session.id} yet.</p>
      : <ol className={styles.log} aria-label={`Conversation with ${thread.session.id}`}>{thread.messages.map(message => <Bubble key={message.key} message={message} />)}</ol>}
    <p className={styles.notice}>{sourcesLine(thread)}</p>
    {thread.gaps.length > 0 && <ul className={styles.gaps} aria-label="Not shown">{thread.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
  </>;
}

/** One session's whole conversation. `fallback` is its card from the wall, shown in the header until the thread answers. */
function OpenConversation({ id, fallback, visible, host, onBack }: { id: string; fallback: WallSession | null; onBack: () => void } & Pick<PaneProps, 'visible' | 'host'>) {
  const def = useMemo(() => openThreadQuery(id), [id]);
  const read = useQuery(def, { enabled: visible, freshMs: WALL_POLL_MS });
  const refetch = useRefetch(def);
  usePollWhileVisible(refetch, WALL_POLL_MS, { enabled: visible });
  const root = useRef<HTMLElement>(null), end = useRef<HTMLDivElement>(null);
  const thread = read.data ?? null, loaded = thread !== null;
  const session = thread?.session ?? fallback;
  useEffect(() => { root.current?.focus(); }, [id]);
  // Open at the newest message, the way a conversation reads; later refreshes leave the reading position alone.
  useEffect(() => { if (loaded) end.current?.scrollIntoView?.({ block: 'nearest' }); }, [loaded]);
  const failure = read.error ? wallFailure(read.error, 'thread') : null;
  const job = session ? aimableJob(session) : null;
  const write = () => { if (job) setLeaderDraft(`@${job} `); host.openPane('leader-thread'); };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Escape' && !event.defaultPrevented) onBack(); };
  return <section ref={root} className={styles.root} tabIndex={-1} aria-label={`Conversation with ${id}`} onKeyDown={onKeyDown}>
    <header className={styles.header}>
      <button type="button" className={styles.link} onClick={onBack} aria-label="Back to every conversation" title="Back to every conversation (Esc)">← All</button>
      {session ? <Identity session={session} /> : <strong className={styles.id}>{id}</strong>}
      <span className={styles.actions}>
        {session?.kind === 'leader' && <button type="button" className={styles.link} onClick={write}>Open the Leader chat</button>}
        {job && <button type="button" className={styles.link} onClick={write} title={`Puts @${job} in the Leader's reply box; nothing is sent until you send it there`}>Write to it</button>}
        {session?.jobId && <button type="button" className={styles.link} onClick={() => { requestWorkerLogJob(session.jobId!); host.openPane('worker-log'); }}>Live log</button>}
        {session?.prUrl && <a className={styles.link} href={session.prUrl} target="_blank" rel="noopener noreferrer">Pull request</a>}
      </span>
    </header>
    {failure && thread && <p className={styles.notice} role="status">
      {failure.kind === 'gone' ? 'This session has left the list. Showing the last read.' : 'Refresh failed. Showing the last read, which may be stale.'}
    </p>}
    {thread ? <ThreadBody thread={thread} />
      : failure ? <Fault failure={failure} onRetry={refetch} />
      : read.data === null ? <p className={styles.fault} role="alert">The server answered with something that is not a session conversation.</p>
      : <p className={styles.loading} role="status">Reading {id}…</p>}
    {session && session.kind !== 'leader' && !job && <p className={styles.notice} role="note">
      {session.state === 'running' || session.state === 'quiet' ? 'This session has no job id a message can be aimed at.' : 'This session is not running, so there is nothing to steer.'} Write to the Leader in the Leader chat.
    </p>}
    <div ref={end} />
  </section>;
}

export function SessionWallPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // Another surface (a routed job in the Leader chat) can ask for one conversation; it is taken once, here.
  useEffect(() => {
    const take = () => { const id = takeRequestedWallSession(); if (id !== null) setOpenId(id); };
    take();
    return subscribeWallSelection(take);
  }, []);
  // The wall's last read stays subscribed while a conversation is open (coming back shows it at once, and the header
  // has a name to show); only the polling stops.
  const read = useQuery(sessionWallQuery, { enabled: visible, freshMs: WALL_POLL_MS });
  const refetch = useRefetch(sessionWallQuery);
  usePollWhileVisible(refetch, WALL_POLL_MS, { enabled: visible && openId === null });
  const wall = read.data ?? null;
  if (openId !== null) {
    return <OpenConversation id={openId} visible={visible} host={host} fallback={wall?.entries.find(entry => entry.session.id === openId)?.session ?? null}
      onBack={() => { setFocusId(openId); setOpenId(null); }} />;
  }
  const failure = read.error ? wallFailure(read.error, 'wall') : null;
  if (wall) {
    return <>
      {failure && <p className={styles.stale} role="status">Refresh failed; showing the last read, which may be stale.</p>}
      <WallView read={wall} onOpen={setOpenId} focusId={focusId} />
    </>;
  }
  return <div className={styles.root}>
    {failure ? <Fault failure={failure} onRetry={refetch}><button type="button" className={styles.link} onClick={() => host.openPane('fleet-sessions')}>Open Sessions</button></Fault>
      : read.data === null ? <p className={styles.fault} role="alert">The server answered with something that is not a list of session conversations.</p>
      : <p className={styles.loading} role="status">Reading every session…</p>}
  </div>;
}
