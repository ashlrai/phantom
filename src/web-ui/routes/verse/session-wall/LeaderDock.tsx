/**
 * The Leader's conversation beside the Conversations wall: the same view and
 * read an opened card uses (fleet-sessions/SessionThread.tsx), so it shows the
 * Leader's replies, what Mason wrote, where each message was routed, and a
 * reply box that writes to the Leader's inbox. It never takes the keyboard on
 * its own; L (SessionWall.tsx) puts the cursor in its reply box. Esc hands the
 * keyboard back to the cards and keeps the conversation where it is; only the
 * Hide button puts it away. While an open conversation covers it, it stays
 * mounted and keeps reading (a query that stops would drop the conversation
 * and the reply box with it), so words typed to the Leader are still there
 * after, under a conversation that is up to date.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { SessionThread } from '../fleet-sessions/SessionThread.js';
import { sessionThreadQuery, THREAD_POLL_MS } from '../fleet-sessions/session-thread-model.js';
import styles from './session-wall.module.css';

const HIDE = { label: 'Hide the Leader conversation', text: 'Hide', title: 'Hide the Leader conversation (L brings it back)' };

export interface LeaderDockProps {
  /** The Leader's session id. */
  id: string;
  visible: boolean;
  /** False while there is no room for it on screen; it keeps its place and its draft. */
  shown: boolean;
  /** Goes up by one each time the reply box is asked for (L); 0 means it never was. */
  replyAsk: number;
  onHide: () => void;
  /** Hand the keyboard back to the cards. */
  onLeave: () => void;
}

export function LeaderDock({ id, visible, shown, replyAsk, onHide, onLeave }: LeaderDockProps) {
  const wrap = useRef<HTMLElement>(null);
  // The same cache entry the conversation itself reads, watched only to know when a reply box can exist.
  const def = useMemo(() => sessionThreadQuery(id), [id]);
  const loaded = useQuery(def, { enabled: visible && replyAsk > 0, freshMs: THREAD_POLL_MS }).data != null;
  // The last ask that reached the reply box. An ask is answered once, so coming back on screen later never takes the keyboard again.
  const answered = useRef(0);
  useEffect(() => {
    if (replyAsk === answered.current || !shown) return;
    // Until the conversation is read, and for a Leader that cannot be written to, the conversation itself takes the keyboard.
    const to = (loaded ? wrap.current?.querySelector<HTMLElement>('textarea') : null) ?? wrap.current?.querySelector<HTMLElement>('section');
    to?.focus();
    if (loaded) answered.current = replyAsk;
  }, [replyAsk, loaded, shown]);

  // Before the conversation's own Esc (which would hide it): Esc here only leaves. The unlock dialog keeps its own Esc.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
    event.preventDefault();
    event.stopPropagation();
    onLeave();
  };
  return <aside ref={wrap} className={styles.leaderDock} hidden={!shown} aria-label="The Leader, beside the conversations" onKeyDownCapture={onKeyDownCapture}>
    <SessionThread id={id} visible={visible} onBack={onHide} backTo={HIDE} autoFocus={false} />
  </aside>;
}
