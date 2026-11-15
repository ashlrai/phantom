/**
 * Phone-first watch view. Reuses the desktop leader thread send path and the
 * same world-model and activity reads the desktop polls.
 */
import { useCallback, useMemo, useState } from 'react';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { leaderThreadQuery, sendLeaderMessage } from '../../leader/thread-data.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { runMobileAction } from '../mobile-actions.js';
import { MobileComposer } from '../MobileComposer.js';
import { PHONE_ACTIVITY_POLL_MS, PHONE_WORLD_POLL_MS, phoneActivityQuery, phoneWorldQuery } from '../watch-queries.js';
import { Button, Screen, ui } from '../ui.js';
import styles from './WatchScreen.module.css';

const THREAD_POLL_MS = 10_000;

function shown(value: number | null, freshness: string): string {
  if (value === null || freshness === 'unknown') return 'unknown';
  return freshness === 'stale' ? `${value} (stale)` : String(value);
}

export function WatchScreen() {
  const { permissions, reachability } = useMobile();
  const world = useQuery(phoneWorldQuery, { freshMs: 5_000 });
  const activity = useQuery(phoneActivityQuery, { freshMs: 2_000 });
  const thread = useQuery(leaderThreadQuery, { freshMs: 5_000 });
  const refetchWorld = useRefetch(phoneWorldQuery);
  const refetchActivity = useRefetch(phoneActivityQuery);
  const refetchThread = useRefetch(leaderThreadQuery);
  usePollWhileVisible(refetchWorld, PHONE_WORLD_POLL_MS);
  usePollWhileVisible(refetchActivity, PHONE_ACTIVITY_POLL_MS);
  usePollWhileVisible(refetchThread, THREAD_POLL_MS);
  const [draft, setDraft] = useState('');
  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const summary = world.data?.value ?? null;
  const agents = activity.data?.value ?? null;
  const messages = thread.data?.value?.messages ?? null;
  const tail = useMemo(() => (messages ?? []).slice(-8), [messages]);
  const disabledReason = !canAct
    ? (permissions.actReason ?? 'This device can read the conversation but not send.')
    : offline
      ? 'This phone cannot reach your Mac. The draft stays here.'
      : thread.data?.value === null
        ? 'The conversation is not available on your Mac.'
        : null;

  const refresh = useCallback(() => Promise.all([refetchWorld(), refetchActivity(), refetchThread()]), [refetchWorld, refetchActivity, refetchThread]);

  const send = (text: string) => {
    runMobileAction({
      title: 'Message the Leader',
      consequences: 'Sends your words on the owner thread.',
      confirmLabel: 'Send',
      confirm: false,
      run: () => sendLeaderMessage(text),
      onDone: () => {
        setDraft((current) => current.trim() === text ? '' : current);
        void refetchThread();
      },
    });
  };

  return (
    <Screen title="Watch" large label="Phone watch" onRefresh={refresh} footer={(
      <MobileComposer
        label="Message the Leader"
        placeholder="Message the Leader…"
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        disabled={disabledReason !== null}
        hint={disabledReason ?? 'Same owner thread as the desktop.'}
      />
    )}>
      <div className={styles.stack}>
        <section className={`${ui.card} ${styles.card}`} aria-label="World model">
          <h2>World</h2>
          {world.data === undefined ? <p className={styles.muted}>Reading the world model…</p> : null}
          {world.data && !summary ? <p className={styles.muted}>{world.data.reason ?? 'The world model is unknown.'}</p> : null}
          {summary ? (
            <>
              {summary.lanes.length === 0 ? <p className={styles.row}>Lanes: none in this reading</p> : summary.lanes.map((lane) => (
                <p key={lane.lane} className={styles.row}>Lane {lane.lane}: headroom {shown(lane.headroom.value, lane.headroom.freshness)}</p>
              ))}
              {summary.pulls === null ? <p className={styles.row}>Pulls: unknown</p> : summary.pulls.length === 0 ? <p className={styles.row}>Pulls: none measured</p> : summary.pulls.map((pull) => (
                <p key={pull.repo} className={styles.row}>Pulls {pull.repo}: {shown(pull.mergedPerDay.value, pull.mergedPerDay.freshness)} merged/day</p>
              ))}
              <p className={styles.row}>Release check: {summary.releases.updateCheck.value ?? 'unknown'}</p>
              <p className={styles.row}>Release train: {summary.releases.train.value ?? 'unknown'}</p>
              <p className={styles.row}>Bottlenecks: {shown(summary.bottlenecks.value, summary.bottlenecks.freshness)}</p>
            </>
          ) : null}
          {world.error ? <Button variant="tinted" onClick={() => refetchWorld()}>Try the world model again</Button> : null}
        </section>
        <section className={`${ui.card} ${styles.card}`} aria-label="Agent activity">
          <h2>Agents</h2>
          {activity.data === undefined ? <p className={styles.muted}>Reading agent activity…</p> : null}
          {activity.data && !agents ? <p className={styles.muted}>{activity.data.reason ?? 'Agent activity is unknown.'}</p> : null}
          {agents && agents.running.length === 0 && agents.recent.length === 0 ? <p className={styles.row}>No agent activity in this reading.</p> : null}
          {agents?.running.map((item) => <p key={item.sessionId} className={styles.row}>Running: {item.title}</p>)}
          {agents?.recent.slice(-4).map((item) => <p key={`${item.sessionId}:${item.at}`} className={styles.row}>{item.outcome}: {item.title}</p>)}
        </section>
        <section className={`${ui.card} ${styles.card}`} aria-label="Owner thread">
          <h2>Leader</h2>
          {thread.data === undefined ? <p className={styles.muted}>Reading the owner thread…</p> : null}
          {messages && messages.length === 0 ? <p className={styles.muted}>No messages yet. Send the first one below.</p> : null}
          <div className={styles.thread}>
            {tail.map((message) => (
              <p key={message.id} className={styles.bubble} data-from={message.from}>
                {message.from === 'mason' ? 'You' : 'Leader'}: {message.text}
              </p>
            ))}
          </div>
          {thread.error ? <p className={styles.muted}>{readFailureReason(thread.error)}</p> : null}
        </section>
      </div>
    </Screen>
  );
}
