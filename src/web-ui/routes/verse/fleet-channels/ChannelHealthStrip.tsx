import { channelHealthLine, type ChannelHealthState, type ChannelHealthView } from './channel-health-model.js';
import styles from './fleet-channels.module.css';

const BADGE: Record<ChannelHealthState, string> = {
  LIVE: styles.healthLive, DEGRADED: styles.healthDegraded, BLOCKED: styles.healthBlocked, UNKNOWN: styles.healthUnknown,
};

function asOfClock(asOf: string | null): string | null {
  const ms = asOf === null ? NaN : Date.parse(asOf);
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Receipt-backed Slack / iMessage state, one row per channel. Read-only. */
export function ChannelHealthStrip({ health, nowMs }: { health: ChannelHealthView; nowMs: number }) {
  if (!health.available) return <p className={styles.message} data-testid="channel-health-unavailable">Channel health not available on this build</p>;
  const clock = asOfClock(health.asOf);
  return <ul className={styles.healthStrip} aria-label="Channel health" data-testid="channel-health">
    {health.channels.map(ch => <li key={ch.channel} className={styles.healthRow}>
      <span className={`${styles.healthBadge} ${BADGE[ch.state]}`}>{ch.state}</span>
      <span>{channelHealthLine(ch, nowMs)}</span>
      {ch.unansweredCount > 0 && <span className={styles.waitingChip}>{ch.unansweredCount} unanswered</span>}
    </li>)}
    {clock !== null && <li className={styles.message}>as of {clock}</li>}
  </ul>;
}
