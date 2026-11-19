/**
 * The Leader pane as the dock and Home mount it: who is working right now,
 * then the conversation. The strip and the conversation are siblings so the
 * strip can hand a job to the reply box without the conversation knowing it.
 *
 * Thread on a strip line reads that session as a conversation in this pane
 * (what it was told, said and did, and a reply box aimed at it). The Leader
 * chat stays mounted underneath, so an unsent draft and the reading position
 * are there when Esc or Back returns to it.
 */
import { useEffect, useRef, useState } from 'react';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { SessionThread } from '../fleet-sessions/SessionThread.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { LeaderRoster } from './LeaderRoster.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';
import styles from './leader-roster.module.css';

const BACK_TO_LEADER = { label: 'Back to the Leader chat', text: '← Leader' };

export function LeaderSurface({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const chat = useRef<HTMLDivElement>(null);
  // The line whose conversation was just closed gets the keyboard back.
  const returnTo = useRef<string | null>(null);
  useEffect(() => {
    if (threadId !== null) { returnTo.current = threadId; return; }
    const from = returnTo.current;
    returnTo.current = null;
    if (from === null) return;
    [...(chat.current?.querySelectorAll<HTMLElement>('[data-roster-thread]') ?? [])].find(button => button.dataset.rosterThread === from)?.focus();
  }, [threadId]);
  const openLog = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  const reading = threadId !== null;
  return <div className={styles.surface}>
    <div ref={chat} className={styles.chat} hidden={reading}>
      <LeaderRoster visible={visible && !reading} onOpenSessions={() => host.openPane('fleet-sessions')} onOpenLog={openLog} onOpenThread={setThreadId} />
      <div className={styles.thread}><LeaderThreadPane visible={visible && !reading} /></div>
    </div>
    {reading && <div className={styles.reading}>
      <SessionThread id={threadId} visible={visible} onBack={() => setThreadId(null)} onOpenLog={openLog} backTo={BACK_TO_LEADER} />
    </div>}
  </div>;
}
