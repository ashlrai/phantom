/**
 * Ask now in the Leader pane: the words go to the Leader thread, which
 * answers in the same request, instead of waiting in the inbox for the next
 * pass. `useAskNow` owns the asks that are out; `AskNowPending` draws each as
 * Mason's line with the Leader's typing dots under it, so the box is free
 * while the Leader thinks. A refused ask stays on screen with the server's
 * reason and three ways out: try again, edit it in the box, or discard it.
 *
 * One ask is out at a time. The write is the Mind conversation's own
 * (leader/thread-data.ts sendLeaderMessage), with the same mutation token.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { refetchQuery } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { leaderThreadQuery, sendLeaderMessage } from '../leader/thread-data.js';
import leaderStyles from '../leader/leader.module.css';
import { waitWords, type PendingAsk } from './ask-now-model.js';
import threadStyles from './leader-thread.module.css';
import styles from './ask-now.module.css';

export interface AskNow {
  pending: readonly PendingAsk[];
  /** An ask is out and has not come back. */
  asking: boolean;
  /** Said under the box after an ask the Leader recorded and did not answer; null otherwise. */
  notice: string | null;
  ask: (text: string) => void;
  retry: (key: string) => void;
  /** Removes a failed ask and returns its words, for the box. */
  take: (key: string) => string | null;
}

export const NO_REPLY_NOTICE = 'The Leader recorded that and did not answer in the same breath. Its reply will appear in the conversation when it comes.';

/** `onLanded` runs after the thread holds the ask (and the reply, when there was one). */
export function useAskNow(onLanded: () => void): AskNow {
  const [pending, setPending] = useState<PendingAsk[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const landed = useRef(onLanded);
  useEffect(() => { landed.current = onLanded; }, [onLanded]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const deliver = useCallback(async (ask: PendingAsk) => {
    try {
      const result = await sendLeaderMessage(ask.text);
      // The pending line gives way only once the read that holds the real one is in, so the words never blink out.
      await refetchQuery(leaderThreadQuery.key, () => leaderThreadQuery.fetch(), true).catch(() => undefined);
      if (!alive.current) return;
      setPending(list => list.filter(item => item.key !== ask.key));
      setNotice(result !== null && result.reply === null ? NO_REPLY_NOTICE : null);
      landed.current();
    } catch (error) {
      if (!alive.current) return;
      setPending(list => list.map(item => item.key === ask.key ? { ...item, state: 'failed', reason: readFailureReason(error) } : item));
    }
  }, []);

  const ask = useCallback((text: string) => {
    seq.current += 1;
    const next: PendingAsk = { key: `ask-${seq.current}`, text, atMs: Date.now(), state: 'waiting', reason: null };
    setNotice(null);
    setPending(list => [...list, next]);
    void deliver(next);
  }, [deliver]);

  const retry = useCallback((key: string) => {
    const found = pending.find(item => item.key === key && item.state === 'failed');
    if (!found || pending.some(item => item.state === 'waiting')) return;
    const again: PendingAsk = { ...found, atMs: Date.now(), state: 'waiting', reason: null };
    setPending(list => list.map(item => item.key === key ? again : item));
    void deliver(again);
  }, [pending, deliver]);

  const take = useCallback((key: string) => {
    const found = pending.find(item => item.key === key && item.state === 'failed');
    if (!found) return null;
    setPending(list => list.filter(item => item.key !== key));
    return found.text;
  }, [pending]);

  return { pending, asking: pending.some(item => item.state === 'waiting'), notice, ask, retry, take };
}

function Waiting({ atMs }: { atMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <section className={leaderStyles.group} data-from="leader" data-ask-waiting aria-label="Leader, replying">
    <header className={leaderStyles.groupHead}>
      <span className={leaderStyles.avatar} data-from="leader" aria-hidden="true">L</span>
      <span className={leaderStyles.who}>Leader</span>
    </header>
    <div className={leaderStyles.groupBody}>
      <p className={styles.wait} role="status">
        <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
        {waitWords(now - atMs)}
      </p>
    </div>
  </section>;
}

export function AskNowPending({ askNow, onEdit }: { askNow: AskNow; onEdit: (text: string) => void }) {
  return <>{askNow.pending.map(ask => <div key={ask.key} className={styles.ask} data-ask={ask.state}>
    <section className={`${leaderStyles.group} ${threadStyles.masonLine}`} data-from="mason" aria-label={ask.state === 'failed' ? 'You, not sent' : 'You, asking now'}>
      <header className={leaderStyles.groupHead}>
        <span className={leaderStyles.avatar} data-from="mason" aria-hidden="true">M</span>
        <span className={leaderStyles.who}>You</span>
        <span className={leaderStyles.channel}>Ask now</span>
      </header>
      <div className={leaderStyles.groupBody}>
        <div className={leaderStyles.entry}>
          <div className={leaderStyles.masonItem}>
            <p className={`${leaderStyles.bubble} ${styles.bubble}`}>{ask.text}</p>
            {ask.state === 'failed' ? <>
              <p className={styles.failed} role="alert">Not sent: {ask.reason ?? 'the reason is unknown.'}</p>
              <p className={styles.actions}>
                <button type="button" className={threadStyles.tool} disabled={askNow.asking} onClick={() => askNow.retry(ask.key)}>Try again</button>
                <button type="button" className={threadStyles.tool} onClick={() => { const text = askNow.take(ask.key); if (text !== null) onEdit(text); }}>Edit</button>
                <button type="button" className={threadStyles.tool} onClick={() => { askNow.take(ask.key); }}>Discard</button>
              </p>
            </> : null}
          </div>
        </div>
      </div>
    </section>
    {ask.state === 'waiting' ? <Waiting atMs={ask.atMs} /> : null}
  </div>)}</>;
}
