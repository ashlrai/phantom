/**
 * The notice above the Leader reply box when the Leader's own passes are
 * failing: how many failed in a row, when one last succeeded, what the failing
 * pass said, and what that means for the words about to be sent. It sits where
 * Mason writes, because a message typed to a Leader that is not reading goes
 * nowhere until a pass succeeds, and the box alone looks the same either way.
 *
 * Drawn only from a counted failure (leader-health-model.ts); a healthy,
 * unread or unknown Leader draws nothing here. Once a notice has been on
 * screen, the first read that counts no failure says the Leader is passing
 * again, until it is dismissed. Read-only: one GET a minute while the pane is
 * on screen, and Check again for a read now.
 */
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../../components/primitives/clipboard.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { LEADER_HEALTH_COMMAND, LEADER_HEALTH_POLL_MS, leaderHealthNotice, leaderHealthQuery } from './leader-health-model.js';
import styles from './leader-health.module.css';

const COPIED_MS = 1_500;

function CopyFix({ command }: { command: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    setState(await copyText(command) ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  }
  return <>
    <button type="button" className={styles.action} data-state={state} aria-label={`Copy the command ${command}`} onClick={() => void copy()}>
      Copy <code>{command}</code>
    </button>
    <span className={styles.copied} role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy; select the command above' : ''}</span>
  </>;
}

export function LeaderHealth({ visible }: { visible: boolean }) {
  const read = useQuery(leaderHealthQuery, { enabled: visible, freshMs: LEADER_HEALTH_POLL_MS });
  const refetch = useRefetch(leaderHealthQuery);
  usePollWhileVisible(refetch, LEADER_HEALTH_POLL_MS, { enabled: visible });
  const failing = (read.data?.failures ?? 0) > 0;
  const [wasFailing, setWasFailing] = useState(false);
  useEffect(() => { if (failing) setWasFailing(true); }, [failing]);

  const notice = leaderHealthNotice(read.data, wasFailing);
  if (notice === null) return null;
  const recovered = notice.state === 'recovered';
  // A kept reading whose refresh failed is still shown, and says it is old.
  const stale = read.error !== undefined;
  return <section className={styles.health} aria-label="Leader health" data-state={notice.state} role={notice.state === 'down' ? 'alert' : 'status'}>
    <p className={styles.head}>
      <span className={styles.dot} aria-hidden="true" />
      <strong className={styles.headline}>{notice.headline}</strong>
      <span className={styles.since}>{notice.lastGood}</span>
    </p>
    <p className={styles.detail}>{notice.detail}</p>
    {recovered ? null : <p className={styles.cause} data-known={notice.cause !== null}>
      <span className={styles.label}>Cause</span>
      {notice.cause !== null ? <code>{notice.cause}</code> : <span>unknown: the failing pass left no output to read</span>}
    </p>}
    {stale ? <p className={styles.stale}>This reading could not be refreshed, so it may be out of date.</p> : null}
    <p className={styles.actions}>
      {recovered
        ? <button type="button" className={styles.action} onClick={() => setWasFailing(false)}>Dismiss</button>
        : <>
          {notice.fix !== null ? <CopyFix command={notice.fix} /> : null}
          <button type="button" className={styles.action} onClick={() => openDockPane('leader-journal')}>Open the journal</button>
          <button type="button" className={styles.action} aria-busy={read.status === 'refreshing' || undefined} onClick={refetch}>Check again</button>
          <span className={styles.command}>Same reading: <code>{LEADER_HEALTH_COMMAND}</code></span>
        </>}
    </p>
  </section>;
}
