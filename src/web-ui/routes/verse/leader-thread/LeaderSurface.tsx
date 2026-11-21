/**
 * The Leader pane as the dock and Home mount it: who is working right now,
 * then the conversation. The strip and the conversation are siblings so the
 * strip can hand a job to the reply box without the conversation knowing it.
 *
 * Thread on a strip line reads that session as a conversation in this pane
 * (what it was told, said and did, and a reply box aimed at it). In a pane
 * wide enough for both (surface-layout.ts) it opens beside the Leader chat,
 * which stays live with its own reply box; in a narrower pane it covers the
 * chat, which stays mounted underneath, so an unsent draft and the reading
 * position are there when Esc or Back returns to it. Either way [ and ] step
 * to the previous and next working session without going back to the strip.
 *
 * Beside the chat, a divider (SurfaceSplitter) gives either side more room.
 * Where it was left and which session was open are kept across a reload
 * (surface-view-store.ts): a wide pane reopens that conversation once the
 * sessions list confirms it still holds the session.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SessionThread } from '../fleet-sessions/SessionThread.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { LeaderRoster } from './LeaderRoster.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import { SurfaceSplitter } from './SurfaceSplitter.js';
import { rosterRows } from './leader-roster-model.js';
import { holdsSession, stepWords, threadStep, useSurfaceFit } from './surface-layout.js';
import { readSurfaceView, writeSurfaceView } from './surface-view-store.js';
import styles from './leader-roster.module.css';

const BACK_TO_LEADER = { label: 'Back to the Leader chat', text: '← Leader' };
const CLOSE_BESIDE = { label: 'Close this conversation', text: 'Close' };

const typingIn = (node: Element | null): node is HTMLElement => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement;

export function LeaderSurface({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [split, setSplit] = useState(() => readSurfaceView().split);
  // The session that was open before a reload, until the sessions list says whether it is still there.
  const [reopen, setReopen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const { beside, measured } = useSurfaceFit(root);
  // The line whose conversation was just closed gets the keyboard back.
  const returnTo = useRef<string | null>(null);
  // A conversation reopened by itself must not take the keyboard from a box being typed in.
  const handBack = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (threadId !== null) {
      returnTo.current = threadId;
      const typing = handBack.current;
      handBack.current = null;
      typing?.focus();
      return;
    }
    const from = returnTo.current;
    returnTo.current = null;
    if (from === null) return;
    [...(chat.current?.querySelectorAll<HTMLElement>('[data-roster-thread]') ?? [])].find(button => button.dataset.rosterThread === from)?.focus();
  }, [threadId]);
  const openLog = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  const reading = threadId !== null;
  // Covered: the conversation is over the chat, so the strip is not on screen to keep the list fresh.
  const covered = reading && !beside;

  /** Mason opens, swaps or closes a conversation: that choice is what a reload returns to. */
  const show = useCallback((session: string | null) => {
    setReopen(null);
    setThreadId(session);
    writeSurfaceView({ session });
  }, []);

  // Decided once, when the pane is first laid out: a wide pane asks the list about the kept session;
  // a narrow one forgets it, because reopening there would cover the Leader chat unasked.
  const decided = useRef(false);
  useEffect(() => {
    if (!measured || decided.current) return;
    decided.current = true;
    const kept = readSurfaceView().session;
    if (kept === null || threadId !== null) return;
    if (beside) setReopen(kept); else writeSurfaceView({ session: null });
  }, [measured, beside, threadId]);

  // The same list the strip reads (one cache entry); polled here only while the strip is covered.
  const sessions = useQuery(liveSessionsQuery, { enabled: visible && (reading || reopen !== null), freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: visible && covered });
  const working = useMemo(() => (sessions.data ? rosterRows(sessions.data).map(row => row.session) : null), [sessions.data]);
  const before = reading && working ? threadStep(working, threadId, -1) : null;
  const after = reading && working ? threadStep(working, threadId, 1) : null;

  // An unreadable list leaves the question open; only a list that answers reopens or forgets.
  useEffect(() => {
    if (reopen === null || !sessions.data) return;
    setReopen(null);
    if (threadId !== null) return;
    if (!holdsSession(sessions.data, reopen)) { writeSurfaceView({ session: null }); return; }
    handBack.current = typingIn(document.activeElement) ? document.activeElement : null;
    setThreadId(reopen);
  }, [reopen, sessions.data, threadId]);

  function onReadingKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // In a text field the brackets are text.
    if (typingIn(event.target as Element)) return;
    const to = event.key === ']' ? after : event.key === '[' ? before : null;
    if (to === null) return;
    event.preventDefault();
    show(to);
  }

  const paneWidth = useCallback(() => root.current?.getBoundingClientRect().width ?? 0, []);
  const keepSplit = useCallback((value: number) => writeSurfaceView({ split: value }), []);

  return <div ref={root} className={styles.surface} data-layout={reading && beside ? 'beside' : undefined}>
    <div ref={chat} className={styles.chat} hidden={covered}>
      <LeaderRoster visible={visible && !covered} onOpenSessions={() => host.openPane('fleet-sessions')} onOpenLog={openLog} onOpenThread={show} openSession={threadId} />
      <div className={styles.thread}><LeaderThreadPane visible={visible && !covered} /></div>
    </div>
    {reading && beside && <SurfaceSplitter split={split} paneWidth={paneWidth} onSplit={setSplit} onKeep={keepSplit} />}
    {reading && <div className={styles.reading} data-layout={beside ? 'beside' : 'over'} onKeyDown={onReadingKeyDown}
      style={beside ? { '--reading-share': `${split}%` } as CSSProperties : undefined}>
      <nav className={styles.stepper} aria-label="Working sessions">
        <button type="button" className={styles.side} disabled={before === null} aria-label="Previous working session" title="Previous working session ([)"
          onClick={() => before !== null && show(before)}>‹</button>
        <span className={styles.position} role="status" data-tone={working === null || !working.includes(threadId) ? 'unknown' : undefined}>{stepWords(working, threadId)}</span>
        <button type="button" className={styles.side} disabled={after === null} aria-label="Next working session" title="Next working session (])"
          onClick={() => after !== null && show(after)}>›</button>
      </nav>
      {/* Keyed by session: lines sent from one conversation never show in the next. */}
      <div className={styles.scroller}>
        <SessionThread key={threadId} id={threadId} visible={visible} onBack={() => show(null)} onOpenLog={openLog} backTo={beside ? CLOSE_BESIDE : BACK_TO_LEADER} />
      </div>
    </div>}
  </div>;
}
