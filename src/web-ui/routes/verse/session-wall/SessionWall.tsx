/**
 * The Conversations pane: every agent session on one screen, each as a short
 * conversation (who it is, a summary assembled from the records, its newest
 * messages, where a reply would go), from one request. Opening a card shows
 * that session's whole conversation in the pane, the view the Sessions pane
 * opens (fleet-sessions/SessionThread.tsx): said to it on the right, said and
 * done by it on the left, recorded steps in the centre, and a reply box that
 * writes through the Leader's inbox, aimed `@RQ-…` at a running worker.
 * Arrow keys (or J and K) move between cards, Enter opens, R opens with the
 * cursor in the reply box, Esc comes back. While a conversation is open and
 * the pane is wide enough, the other sessions stay listed beside it
 * (SessionRail.tsx) and J and K step to the next and previous conversation.
 * The bar above the wall (WallBar.tsx) finds among the sessions on screen and
 * asks the server for one lane, one repo or only running sessions; both are
 * kept across a reload. N opens the next conversation with new messages; the
 * counts behind the "N new" marks are kept across a reload too (wall-seen.ts).
 * With room, the Leader's conversation and its reply box stay on the right of
 * all of it (LeaderDock.tsx, wall-leader.ts), and L goes to that reply box.
 * O changes the card order; the side list follows it.
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SessionThread } from '../fleet-sessions/SessionThread.js';
import { sessionThreadQuery, THREAD_POLL_MS } from '../fleet-sessions/session-thread-model.js';
import { clockTime } from '../leader/thread-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { LeaderDock } from './LeaderDock.js';
import { newLabel, railEntries, railStep, SessionRail } from './SessionRail.js';
import { leaderIdOf, loadLeaderHidden, saveLeaderHidden, useLeaderRoom } from './wall-leader.js';
import { nextUnseen, noteWallSeen, unseenCount, unseenSessions } from './wall-seen.js';
import { arrangeEntries, groupHeads, loadWallOrder, nextOrder, saveWallOrder, type WallOrder } from './wall-order.js';
import { loadWallView, saveWallView } from './wall-view-store.js';
import { subscribeWallSelection, takeRequestedWallSession } from './wall-selection.js';
import { findEntries, isScoped, NO_SCOPE, replyLine, scopeChoices, scopeWords, sessionWallQueryFor, stateCounts, STATE_WORD, WALL_POLL_MS, WALL_STATES, wallFailure, wallHeadline,
  type SessionWallRead, type WallEntry, type WallFailure, type WallScope, type WallSession, type WallState } from './session-wall-model.js';
import { WallBar } from './WallBar.js';
import { WallRequests } from './WallRequests.js';
import { servedEntries } from './wall-requests-model.js';
import styles from './session-wall.module.css';

const spoke = (session: WallSession) => (session.lastMessageAgeSeconds === null ? 'last spoke unknown' : `spoke ${sessionAge(session.lastMessageAgeSeconds)} ago`);

/** One session on the wall. The card is a single button, so its text stays plain; the opened conversation renders markdown. */
function Card({ entry, fresh, onOpen }: { entry: WallEntry; fresh: number; onOpen: (id: string) => void }) {
  const { session } = entry, summaryId = useId(), freshId = useId();
  const earlier = entry.messageCount - entry.messages.length;
  return <li className={styles.card} data-state={session.state}>
    <button type="button" className={styles.open} data-card={session.id} onClick={() => onOpen(session.id)}
      aria-label={`${session.id}, ${STATE_WORD[session.state]}`} aria-describedby={fresh > 0 ? `${freshId} ${summaryId}` : summaryId}>
      <span className={styles.top}>
        {session.kind === 'worker' && session.lane !== 'unknown' && <ProviderBadge of={session.lane} iconOnly size={14} />}
        <strong className={styles.id}>{session.id}</strong>
        <span className={styles.state} data-state={session.state}>{STATE_WORD[session.state]}</span>
        {fresh > 0 && <span id={freshId} className={styles.fresh}>{fresh} new</span>}
        <span className={styles.muted}>{spoke(session)}</span>
      </span>
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
      <span className={styles.replyTo} data-to={entry.reply.to} title={entry.reply.hint}>{replyLine(entry.reply)}</span>
    </button>
  </li>;
}

const cardsIn = (list: HTMLElement | null) => [...(list?.querySelectorAll<HTMLButtonElement>('button[data-card]') ?? [])];

export interface WallViewProps {
  read: SessionWallRead;
  /** The second argument asks for the reply box (R on a card). */
  onOpen: (id: string, toReply?: boolean) => void;
  /** The session to put the keyboard back on (the one just closed). */
  focusId?: string | null;
  /** Words from the find box; only sessions holding all of them are shown. */
  find?: string;
  /** What the read was asked to narrow to, so an empty answer names it. */
  scope?: WallScope;
  /** A session whose whole conversation is on screen beside the cards (the Leader's); its card carries no "new" mark. */
  readingId?: string | null;
  order?: WallOrder;
}

export function WallView({ read, onOpen, focusId = null, find = '', scope = NO_SCOPE, readingId = null, order = 'fleet' }: WallViewProps) {
  const [only, setOnly] = useState<WallState | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const onScreen = findEntries(read.entries, find);
  // One message of Mason's leaves only the sessions serving it; the state buttons then count those.
  const found = servedEntries(onScreen, asked);
  // Counted from the sessions the find box leaves, so a state button never promises a card it cannot show.
  const counts = stateCounts(found);
  const unshown = read.total === null ? 0 : read.total - read.entries.length;
  // A filter whose last session has changed state falls back to everything rather than showing an empty wall.
  const filter = only !== null && counts[only] > 0 ? only : null;
  // Arranged last, so the headings of a grouped wall count only the cards under them.
  const shown = arrangeEntries(filter === null ? found : found.filter(entry => entry.session.state === filter), order, read.entries);
  const heads = groupHeads(shown, order, read.entries);
  const next = nextUnseen(shown, readingId);
  useEffect(() => { if (focusId !== null) cardsIn(list.current).find(card => card.dataset.card === focusId)?.focus(); }, [focusId]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const all = cardsIn(list.current), at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'r' && at >= 0) {
      event.preventDefault();
      onOpen(all[at]!.dataset.card!, true);
      return;
    }
    const to = event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'j' ? Math.min(at + 1, all.length - 1)
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'k' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (to < 0 || !all[to]) return;
    event.preventDefault();
    all[to].focus();
  };
  return <section className={styles.root} aria-label="Every session as a conversation">
    <p className={styles.headline}>{wallHeadline(read)}</p>
    {next !== null && <button type="button" className={styles.next} data-next-new={next} onClick={() => onOpen(next)} title="Open the first conversation with new messages (N)">
      {newLabel(unseenSessions(shown, readingId))} <kbd>N</kbd>
    </button>}
    {found.length > 0 && <div className={styles.filters} role="group" aria-label="Show sessions by state">
      <button type="button" className={styles.filter} aria-pressed={filter === null} onClick={() => setOnly(null)}>All <span>{found.length}</span></button>
      {WALL_STATES.filter(state => counts[state] > 0).map(state =>
        <button key={state} type="button" className={styles.filter} data-state={state} aria-pressed={filter === state}
          onClick={() => setOnly(filter === state ? null : state)}>{STATE_WORD[state]} <span>{counts[state]}</span></button>)}
    </div>}
    <WallRequests entries={onScreen} chosen={asked} onChoose={setAsked} />
    {read.entries.length === 0
      ? <p className={styles.empty} role="status">{read.total ? 'The list holds sessions, but none came back as a conversation.'
        : isScoped(scope) ? `No sessions in ${scopeWords(scope)} right now. This keeps asking; "Every session" shows the rest.`
        : 'No agent sessions right now. Each one appears here as the fleet starts it.'}</p>
      : found.length === 0
      ? <p className={styles.empty} role="status">No conversation on screen holds “{find.trim()}”. It looks in each session's id, lane, model, repo, summary and newest messages{unshown > 0 ? `; ${unshown} more session${unshown === 1 ? ' is' : 's are'} not on screen` : ''}.</p>
      : <ul ref={list} className={styles.wall} aria-label="Conversations" onKeyDown={onKeyDown}>
        {shown.map(entry => {
          const head = heads.get(entry.session.id);
          return <Fragment key={entry.session.id}>
            {head && <li className={styles.group} role="separator" data-group={head.label} aria-label={`${head.label}, ${head.count}`}>
              {order === 'lane' && head.name !== null && <ProviderBadge of={head.name} iconOnly size={12} />}
              <strong>{head.label}</strong><span>{head.count}</span>
            </li>}
            <Card entry={entry} fresh={unseenCount(entry, readingId)} onOpen={onOpen} />
          </Fragment>;
        })}
      </ul>}
    {read.gaps.length > 0 && <ul className={styles.gaps} aria-label="Not shown">{read.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Updated {clockTime(read.generatedAt) || 'at an unknown time'}. Enter opens a conversation, R opens it ready to reply, N opens the next with new messages, / finds, L writes to the Leader, O changes the order. Summaries are assembled from the records, not written by a model. Same read for agents: <code>phm sessions threads --json</code></p>
  </section>;
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

const BACK_TO_WALL = { label: 'Back to every conversation', text: '← All' };

/** One session's whole conversation, with its reply box. `toReply` puts the cursor in the box once the conversation has been read. */
function OpenConversation({ id, toReply, visible, host, onBack }: { id: string; toReply: boolean; onBack: () => void } & Pick<PaneProps, 'visible' | 'host'>) {
  const wrap = useRef<HTMLDivElement>(null);
  // The same cache entry the conversation itself reads, watched only to know when a reply box can exist.
  const def = useMemo(() => sessionThreadQuery(id), [id]);
  const loaded = useQuery(def, { enabled: visible && toReply, freshMs: THREAD_POLL_MS }).data != null;
  useEffect(() => { if (toReply && loaded) wrap.current?.querySelector('textarea')?.focus(); }, [toReply, loaded]);
  return <div ref={wrap} className={styles.opened}>
    <SessionThread id={id} visible={visible} onBack={onBack} backTo={BACK_TO_WALL}
      onOpenLog={job => { requestWorkerLogJob(job); host.openPane('worker-log'); }} />
  </div>;
}

export function SessionWallPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const [open, setOpen] = useState<{ id: string; toReply: boolean } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // Another surface (a routed job in the Leader chat) can ask for one conversation; it is taken once, here.
  useEffect(() => {
    const take = () => { const id = takeRequestedWallSession(); if (id !== null) setOpen({ id, toReply: false }); };
    take();
    return subscribeWallSelection(take);
  }, []);
  // The wall's read keeps polling while a conversation is open: it is the list beside it, and coming back shows it at once.
  // The find words and the narrowing are where Mason left them, across a reload (wall-view-store.ts).
  const [kept] = useState(() => loadWallView());
  const [find, setFind] = useState(kept.find);
  const [scope, setScope] = useState<WallScope>(kept.scope);
  useEffect(() => { saveWallView({ find, scope }); }, [find, scope]);
  const [choices, setChoices] = useState<{ lanes: readonly string[]; repos: readonly string[] }>({ lanes: [], repos: [] });
  const wrap = useRef<HTMLDivElement | null>(null);
  // The pane's own box, held as state too so its width is measured as soon as it exists.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => { wrap.current = node; setBox(node); }, []);
  const room = useLeaderRoom(box);
  const [leaderHidden, setLeaderHidden] = useState(() => loadLeaderHidden());
  useEffect(() => { saveLeaderHidden(leaderHidden); }, [leaderHidden]);
  const [replyAsk, setReplyAsk] = useState(0);
  const def = useMemo(() => sessionWallQueryFor(scope), [scope]);
  const read = useQuery(def, { enabled: visible, freshMs: WALL_POLL_MS });
  const refetch = useRefetch(def);
  usePollWhileVisible(refetch, WALL_POLL_MS, { enabled: visible });
  const wall = read.data ?? null;
  // The order is where Mason left it too (wall-order.ts). The list beside an open conversation, and J, K and N in it, follow the same order as the cards.
  const [order, setOrder] = useState<WallOrder>(() => loadWallOrder());
  useEffect(() => { saveWallOrder(order); }, [order]);
  const listed = useMemo(() => (wall && order !== 'fleet' ? { ...wall, entries: [...arrangeEntries(wall.entries, order)] } : wall), [wall, order]);
  // The card the keyboard was on when O changed the order: moving a card takes the focus off it, so it is put back.
  const held = useRef<string | null>(null);
  useEffect(() => {
    const id = held.current;
    held.current = null;
    if (id !== null) cardsIn(wrap.current).find(card => card.dataset.card === id)?.focus();
  }, [order]);
  const openId = open?.id ?? null;
  const leaderId = leaderIdOf(wall?.entries);
  // Beside the cards from the first width, beside an open conversation only with room for three columns; never twice on one screen.
  const leaderFits = room > 0 && (openId === null || (room === 2 && openId !== leaderId));
  // Kept mounted (and its draft with it) while a conversation covers it; on screen only when it fits.
  const leaderMounted = room > 0 && !leaderHidden, leaderShown = leaderMounted && leaderFits;
  const readingId = leaderShown ? leaderId : null;
  // After each read is drawn: first sight of a session is its starting count, and a conversation on screen counts as read.
  useEffect(() => {
    if (!wall) return;
    noteWallSeen(wall.entries, openId ?? readingId, isScoped(scope));
    if (openId !== null && readingId !== null) noteWallSeen(wall.entries, readingId, isScoped(scope));
  }, [wall, openId, readingId, scope]);
  // Lanes and repos seen in any read stay on offer, so narrowing to one does not hide the way to another.
  useEffect(() => {
    setChoices(known => {
      const lanes = scopeChoices(known.lanes, wall?.entries ?? [], 'lane', scope.lane), repos = scopeChoices(known.repos, wall?.entries ?? [], 'repo', scope.repo);
      return lanes === known.lanes && repos === known.repos ? known : { lanes, repos };
    });
  }, [wall, scope]);
  /** L: the cursor goes to the Leader's reply box, beside the wall when it fits there, otherwise in the Leader's own conversation. */
  const talkToLeader = () => {
    if (leaderFits) { setLeaderHidden(false); setReplyAsk(asks => asks + 1); }
    else if (openId === leaderId) wrap.current?.querySelector<HTMLElement>('[data-wall-side] textarea')?.focus();
    else setOpen({ id: leaderId, toReply: true });
  };
  /** Esc in the Leader's conversation: back to the cards, or to the conversation that is open. */
  const leaveLeader = () => {
    const side = wrap.current?.querySelector<HTMLElement>('[data-wall-side]');
    (side?.querySelector<HTMLElement>('button[data-card]') ?? side?.querySelector<HTMLElement>('section[tabindex]') ?? side?.querySelector<HTMLElement>('input[type="search"]'))?.focus();
  };
  let side: ReactNode;
  if (open !== null) {
    const close = () => { setFocusId(open.id); setOpen(null); };
    // J and K step through the conversations listed, N goes to the next one with new messages, from anywhere but a text field or the unlock dialog.
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'j' && event.key !== 'k' && event.key !== 'n')) return;
      if (event.target instanceof Element && event.target.closest('textarea, input, select, [role="dialog"]')) return;
      const to = event.key === 'n' ? nextUnseen(railEntries(listed, find, open.id), open.id) : railStep(listed, open.id, event.key === 'j' ? 1 : -1, find);
      if (to === null) return;
      event.preventDefault();
      setOpen({ id: to, toReply: false });
    };
    side = <div className={styles.split} onKeyDown={onKeyDown}>
      <div className={styles.columns}>
        <SessionRail read={listed} failed={read.error != null} openId={open.id} onPick={id => setOpen({ id, toReply: false })} onClose={close}
          find={find} onShowAll={() => setFind('')} />
        {/* Keyed by session, so a line sent to one conversation never shows in the next. */}
        <OpenConversation key={open.id} id={open.id} toReply={open.toReply} visible={visible} host={host} onBack={close} />
      </div>
    </div>;
  } else {
    const failure = read.error ? wallFailure(read.error) : null;
    // The bar keeps its place in the tree through every state below, so choosing a lane never takes the keyboard off the control.
    side = <>
      {(wall || isScoped(scope)) && <WallBar find={find} onFind={setFind} scope={scope} onScope={setScope} lanes={choices.lanes} repos={choices.repos} read={wall} order={order} onOrder={setOrder}
        onLeave={() => wrap.current?.querySelector<HTMLButtonElement>('button[data-card]')?.focus()} />}
      {room > 0 && leaderHidden && <button type="button" className={styles.leaderShow} onClick={() => setLeaderHidden(false)} title="Show the Leader conversation beside the cards (L writes to the Leader)">
        Leader conversation <kbd>L</kbd>
      </button>}
      {wall ? <>
        {failure && <p className={styles.stale} role="status">Refresh failed; showing the last read, which may be stale.</p>}
        <WallView read={wall} onOpen={(id, toReply = false) => setOpen({ id, toReply })} focusId={focusId} find={find} scope={scope} readingId={readingId} order={order} />
      </> : <div className={styles.root}>
        {failure ? <Fault failure={failure} onRetry={refetch}><button type="button" className={styles.link} onClick={() => host.openPane('fleet-sessions')}>Open Sessions</button></Fault>
          : read.data === null ? <p className={styles.fault} role="alert">The server answered with something that is not a list of session conversations.</p>
          : <p className={styles.loading} role="status">{isScoped(scope) ? `Reading sessions in ${scopeWords(scope)}…` : 'Reading every session…'}</p>}
      </div>}
    </>;
  }
  // From anywhere in the pane but a field: L writes to the Leader. On the wall, "/" puts the cursor in the find box and N opens the first conversation with new messages.
  const onKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.key !== 'l' && (open !== null || (event.key !== '/' && event.key !== 'n' && event.key !== 'o')))) return;
    if (event.target instanceof Element && event.target.closest('textarea, input, select, [role="dialog"]')) return;
    if (event.key === 'l') { event.preventDefault(); talkToLeader(); return; }
    if (event.key === 'o') {
      event.preventDefault();
      held.current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-card]')?.dataset.card ?? null : null;
      setOrder(nextOrder);
      return;
    }
    if (event.key === 'n') {
      // The button is on screen only while a card shown holds something new, so the key and the button always agree.
      const next = wrap.current?.querySelector<HTMLButtonElement>('button[data-next-new]');
      if (next) { event.preventDefault(); next.click(); }
      return;
    }
    const box = wrap.current?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!box) return;
    event.preventDefault();
    box.focus();
    box.select();
  };
  return <div ref={attach} className={styles.narrowed} data-leader={leaderShown ? 'beside' : undefined} onKeyDown={onKeys}>
    <div className={styles.wallSide} data-wall-side>{side}</div>
    {leaderMounted && <LeaderDock id={leaderId} visible={visible} shown={leaderShown} replyAsk={replyAsk} onHide={() => setLeaderHidden(true)} onLeave={leaveLeader} />}
  </div>;
}
