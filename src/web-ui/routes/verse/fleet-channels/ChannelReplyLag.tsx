import { formatAge, formatRelative } from '../autonomy/format.js';
import type { ChannelReplyLag } from './channel-reply-lag.js';
import styles from './fleet-channels.module.css';

/**
 * One row's reply debt on the owner thread: Mason's last message on the
 * channel and whether the Leader answered it there. `channelName` is set only
 * when a folded raw channel (e.g. Slack inside 'Other') owns the lag, so the
 * line can still name the surface Mason wrote on. Read-only — nothing here
 * can send.
 */
export function ChannelReplyLag({ lag, nowMs, channelName }: { lag: ChannelReplyLag; nowMs: number; channelName?: string }) {
  const waiting = lag.waitingMs !== null;
  return <>
    <p className={styles.presence} data-testid="channel-reply-lag">
      {channelName !== undefined && `${channelName} · `}Last from Mason {formatRelative(lag.lastFromMasonAt, nowMs)} · {lag.preview}
    </p>
    <p className={styles.presence}>
      {waiting
        ? <>Leader reply unanswered{lag.overdue && <> · <span className={styles.waitingChip} role="status">waiting {formatAge(lag.lastFromMasonAt, nowMs)}</span></>}</>
        : `Leader reply ${formatRelative(lag.replyAt, nowMs)}`}
    </p>
  </>;
}
