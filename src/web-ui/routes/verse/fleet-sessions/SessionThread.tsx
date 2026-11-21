/**
 * One session as a conversation, opened from a row of the Sessions pane: a
 * summary assembled from the records, then what was said to the session
 * (right), what it said and did (left) and its recorded steps (centre), where
 * Mason's messages were routed, and a reply box. A reply goes through the
 * Leader's inbox, the route the Leader chat uses, aimed where the read's
 * `reply` field says (`@RQ-…` for a running worker); nothing is sent to a
 * session that is not running. Built on GET /api/verse/fleet/control/session-thread.
 * While it is open the conversation is followed (thread-follow.ts): messages that
 * arrive with the end on screen scroll into view, the rest wait under a "New" mark.
 * A conversation read to its end before (thread-read-store.ts) opens at the first
 * message that arrived since, under the same mark. A running worker's job is paused,
 * resumed, stopped or moved from the row under the header (ThreadControls.tsx), and
 * each such request reads in the conversation as a record line.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { clockTime } from '../leader/thread-model.js';
import { inboxHeld } from '../leader-thread/inbox-held-model.js';
import { LeaderHealth } from '../leader-thread/LeaderHealth.js';
import { sendLeaderInboxMessage } from '../leader-thread/leader-inbox-data.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ThreadEarlier } from './ThreadEarlier.js';
import { ThreadWork } from './ThreadWork.js';
import { onRecord, replyText, routedRow, sessionThreadQuery, sourcesLine, STATE_WORD, threadFailure, THREAD_POLL_MS, THREAD_REPLY_MAX,
  type SessionThread as Thread, type ThreadMessage } from './session-thread-model.js';
import { ThreadControls } from './ThreadControls.js';
import { dayBreaks, NEW_MARK_ATTR, newCountLabel, useThreadFollow } from './thread-follow.js';
import { noteThreadRead, unreadSince } from './thread-read-store.js';
import { restoredLabel } from '../leader-thread/reply-draft-model.js';
import { DraftLeft } from './ThreadDraftMark.js';
import { addThreadSent, keptThreadDraft, setThreadDraft, settleThreadSent, threadDraft, useSentLines, useThreadDraft } from './thread-draft-store.js';
import draftStyles from './thread-draft.module.css';
import styles from './session-thread.module.css';

interface SentLine { key: string; at: string; text: string }

function Bubble({ message }: { message: ThreadMessage }) {
  const at = message.at ? clockTime(message.at) : '';
  if (message.kind === 'routing') {
    // Where the Leader sent one of Mason's messages: a row per job, its pull request as a link.
    return <li className={styles.routing} data-side="record" data-kind="routing">
      <span className={styles.recordLabel}>{message.label}</span>
      <ul className={styles.routed}>{message.text.split('\n').map(routedRow).map(row => <li key={row.text}>
        {row.text}{row.pr && <> <a href={row.pr} target="_blank" rel="noopener noreferrer">PR #{/\/pull\/(\d+)/.exec(row.pr)![1]}</a></>}
      </li>)}</ul>
    </li>;
  }
  if (message.side === 'record') {
    return <li className={styles.record} data-side="record" data-kind={message.kind}>
      <span className={styles.recordLabel}>{message.label}</span>{message.text && <span>{message.text}</span>}{at && <time dateTime={message.at!}>{at}</time>}
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

function ReplyBox({ thread, onSent }: { thread: Thread; onSent: (line: SentLine) => void }) {
  // The words belong to the session they were typed to (thread-draft-store.ts): they wait there while another conversation is read.
  const route = thread.reply, id = thread.session.id;
  const [draft, setDraft] = useThreadDraft(id);
  // A box that opens holding words kept from before says so, until they are edited or sent.
  const [restored, setRestored] = useState(() => { const kept = keptThreadDraft(id); return kept ? restoredLabel(kept, Date.now()) : null; });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const inFlight = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Once the read holds the inbox's own record of a line sent from here, the kept copy is dropped.
  useEffect(() => settleThreadSent(id, text => onRecord(thread, text)), [id, thread]);
  if (route.to === 'none') return <><p className={styles.noReply} role="note">{route.hint}</p><DraftLeft id={id} /></>;
  const outgoing = replyText(route, draft);
  const tooLong = draft.trim() !== '' && outgoing === null;

  async function send() {
    if (inFlight.current || outgoing === null) return;
    if (!hasMutationHold()) { setUnlockOpen(true); return; }
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      await sendLeaderInboxMessage(outgoing);
      const at = new Date().toISOString(), line = { key: `sent:${at}`, at, text: outgoing };
      // Another conversation may be on screen by now: the line is filed under the session it was written to.
      if (alive.current) onSent(line); else addThreadSent(id, line);
      // Words typed while it was on its way are a new draft, and stay.
      if (replyText(route, threadDraft(id)) === outgoing) setThreadDraft(id, '');
      setRestored(null);
    } catch (error) {
      setFailure(inboxHeld(error)?.reason ?? readFailureReason(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  const name = route.to === 'leader' ? 'the Leader' : route.job;
  return <form className={styles.reply} onSubmit={onSubmit}>
    <textarea className={styles.box} rows={2} value={draft} maxLength={THREAD_REPLY_MAX} aria-label={`Message ${name}`}
      placeholder={`Message ${name}. Enter sends, Shift+Enter adds a line.`} onChange={event => { setRestored(null); setDraft(event.target.value); }} onKeyDown={onKeyDown} />
    <button type="submit" className={styles.send} disabled={sending || outgoing === null}>{sending ? 'Sending…' : 'Send'}</button>
    <p className={styles.hint}>{tooLong ? `Too long: a message holds ${THREAD_REPLY_MAX.toLocaleString('en-US')} characters.` : route.hint}</p>
    {restored && draft !== '' && <p className={draftStyles.kept} role="status" data-draft-restored>{restored}</p>}
    {failure && <p className={styles.failure} role="alert">Not sent. {failure}</p>}
    <MutationTokenDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} onUnlocked={() => void send()}
      reason="Messaging a session requires the dispatch token." tokenHelp="the mutation token ashlr verse printed" />
  </form>;
}

export interface SessionThreadViewProps {
  thread: Thread;
  sent: readonly SentLine[];
  onSent: (line: SentLine) => void;
  /** The message the "New" mark sits above: the first one that arrived while the reader was further up. */
  markKey?: string | null;
  /** Drawn just above the reply box: the notice that the Leader, which every reply goes through, is not reading. */
  aboveReply?: ReactNode;
}

export function SessionThreadView({ thread, sent, onSent, markKey = null, aboveReply = null }: SessionThreadViewProps) {
  const { session } = thread;
  const days = useMemo(() => dayBreaks(thread.messages), [thread.messages]);
  // Once the read holds Mason's own record of a message, the local copy steps aside for it.
  const waiting = sent.filter(line => !onRecord(thread, line.text));
  return <>
    <div className={styles.summary} aria-label="Summary">
      <span className={styles.summaryTitle}>Summary <span className={styles.muted}>from the records, as of {clockTime(thread.generatedAt) || 'an unknown time'}</span></span>
      <ThreadWork thread={thread} />
    </div>
    {thread.messages.length === 0 && waiting.length === 0
      ? <p className={styles.empty} role="status">Nothing is recorded for {session.id} yet.</p>
      : <ol className={styles.log} aria-label={`Conversation with ${session.id}`}>
        {thread.messages.map(message => <Fragment key={message.key}>
          {days.has(message.key) && <li className={styles.day} role="separator" data-day>{days.get(message.key)}</li>}
          {message.key === markKey && <li className={styles.newMark} role="separator" {...{ [NEW_MARK_ATTR]: '' }}>New</li>}
          <Bubble message={message} />
        </Fragment>)}
        {waiting.map(line => <li key={line.key} className={styles.entry} data-side="other" data-kind="sent">
          <span className={styles.label}>You, from here · <time dateTime={line.at}>{clockTime(line.at)}</time></span>
          <div className={styles.bubble}><p className={styles.plain}>{line.text}</p></div>
          <span className={styles.receipt}>In the Leader&apos;s inbox. It shows in this conversation once a record names it.</span>
        </li>)}
      </ol>}
    <p className={styles.sources}>{sourcesLine(thread)}</p>
    <ThreadEarlier thread={thread} />
    {aboveReply}
    <ReplyBox key={thread.session.id} thread={thread} onSent={onSent} />
  </>;
}

export interface SessionThreadProps {
  id: string;
  visible: boolean;
  onBack: () => void;
  /** Opens the session's live log (pause and stop live there); given only for a session with a job. */
  onOpenLog?: (job: string) => void;
  /** Where Back and Esc return to, in words, when the conversation is opened from somewhere other than the Sessions pane. `title` replaces the button's tooltip where Esc does something else. */
  backTo?: { label: string; text: string; title?: string };
  /** False where the conversation sits beside something else and must not take the keyboard when it appears. */
  autoFocus?: boolean;
  /** False where the same screen already says the Leader is not reading (the Leader chat beside it, the Leader's own conversation beside the wall). */
  leaderHealth?: boolean;
}

const BACK_TO_SESSIONS = { label: 'Back to all sessions', text: '← Sessions' };
const NOTHING_UNREAD: readonly string[] = [];

export function SessionThread({ id, visible, onBack, onOpenLog, backTo = BACK_TO_SESSIONS, autoFocus = true, leaderHealth = true }: SessionThreadProps) {
  const def = useMemo(() => sessionThreadQuery(id), [id]);
  const read = useQuery(def, { enabled: visible, freshMs: THREAD_POLL_MS });
  const refetch = useRefetch(def);
  usePollWhileVisible(refetch, THREAD_POLL_MS, { enabled: visible });
  // Filed under the session, so a line sent to one conversation never shows in the next one opened in its place.
  const [sent, setSent] = useSentLines(id);
  const root = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const thread = read.data ?? null;
  const loaded = thread !== null;
  const keys = useMemo(() => thread?.messages.map(message => message.key) ?? null, [thread]);
  // What arrived since this conversation was last read to its end, worked out once, from its first read (set during render, so the first paint has it).
  const [opened, setOpened] = useState<{ id: string; unread: readonly string[] } | null>(null);
  if (thread !== null && opened?.id !== id) setOpened({ id, unread: unreadSince(id, thread.messages) });
  const unreadAtOpen = opened?.id === id ? opened.unread : NOTHING_UNREAD;
  const follow = useThreadFollow(id, keys, root, end, unreadAtOpen);
  const { caughtUp, jumpToNew } = follow;
  const openMark = unreadAtOpen[0] ?? null;
  const atOpenMark = openMark !== null && follow.markKey === openMark;
  useEffect(() => { if (autoFocus) root.current?.focus(); }, [id, autoFocus]);
  // Open at the newest message, the way a conversation reads, unless messages arrived since it was last read: then open at the first of those.
  // Later reads are followed or held by useThreadFollow; a line sent from here always scrolls into view.
  useEffect(() => { if (loaded && (openMark === null || sent.length > 0)) end.current?.scrollIntoView?.({ block: 'nearest' }); }, [loaded, sent.length, openMark]);
  useEffect(() => { if (atOpenMark) jumpToNew(); }, [atOpenMark, jumpToNew]);
  // Read to the end: this is the place the next opening counts from.
  useEffect(() => { if (thread !== null && caughtUp) noteThreadRead(id, thread.messages); }, [id, thread, caughtUp]);

  const failure = read.error ? threadFailure(read.error) : null;
  const session = thread?.session;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // End goes to the newest message from anywhere in the conversation but a text field, where it keeps moving the caret.
    if (event.key === 'End' && !event.defaultPrevented && !(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      follow.jumpToEnd();
      return;
    }
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Escape in a reply box that holds words keeps them; it leaves only from an empty box or the conversation.
    if (event.target instanceof HTMLTextAreaElement && event.target.value !== '') return;
    // Escape inside the unlock dialog closes the dialog, not the conversation.
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    onBack();
  };
  return <section ref={root} className={styles.root} tabIndex={-1} aria-label={`Session ${id}`} onKeyDown={onKeyDown}>
    <header className={styles.header}>
      <button type="button" className={styles.back} onClick={onBack} aria-label={backTo.label} title={backTo.title ?? `${backTo.label} (Esc)`}>{backTo.text}</button>
      {session?.kind === 'worker' && session.lane !== 'unknown' && <ProviderBadge of={session.lane} iconOnly size={14} />}
      <strong className={styles.id}>{id}</strong>
      {session && <span className={styles.state} data-state={session.state}>{STATE_WORD[session.state]}</span>}
      {session && <span className={styles.muted}>
        {session.lastMessageAgeSeconds === null ? 'last spoke unknown' : `spoke ${sessionAge(session.lastMessageAgeSeconds)} ago`}
      </span>}
      <span className={styles.actions} aria-live="polite">
        {follow.unseen > 0 && <button type="button" className={styles.newPill} onClick={follow.jumpToNew}
          aria-label={`${newCountLabel(follow.unseen)}, go to the first`} title="Go to the first new message (End goes to the newest)">
          {follow.unseen} new ↓
        </button>}
        {session?.jobId && onOpenLog && <button type="button" className={styles.link} onClick={() => onOpenLog(session.jobId!)}>Live log</button>}
        {session?.prUrl && <a className={styles.link} href={session.prUrl} target="_blank" rel="noopener noreferrer">Pull request</a>}
      </span>
    </header>
    {failure && thread && <p className={styles.notice} role="status">
      {failure.kind === 'gone' ? 'This session has left the list. Showing the last read.' : 'Refresh failed. Showing the last read, which may be stale.'}
    </p>}
    {thread && <ThreadControls thread={thread} onDone={refetch} />}
    {thread ? <SessionThreadView thread={thread} sent={sent} markKey={follow.markKey} onSent={line => setSent(lines => [...lines, line])}
      // Only where there is a box to write in: a session that takes no message is not waiting on the Leader.
      aboveReply={leaderHealth && thread.reply.to !== 'none' ? <LeaderHealth visible={visible} place="thread" to={thread.reply.to === 'job' ? thread.reply.job : null} /> : null} />
      : failure ? <div className={styles.fault} role="alert" data-kind={failure.kind}>
        <p className={styles.plain}>{failure.text}</p>
        {failure.kind !== 'unsupported' && <button type="button" className={styles.link} onClick={refetch}>Try again</button>}
      </div>
      : read.data === null ? <p className={styles.fault} role="alert">The server answered with something that is not a session conversation.</p>
      : <p className={styles.loading} role="status">Reading {id}…</p>}
    <div ref={end} />
  </section>;
}
