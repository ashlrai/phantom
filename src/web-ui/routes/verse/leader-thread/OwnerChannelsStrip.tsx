import leaderStyles from '../leader/leader.module.css';
import styles from './leader-thread.module.css';
import type { OwnerChannelState, ReplyGapState } from './owner-thread-queries.js';

const names: Record<string, string> = { desktop: 'Desktop', imessage: 'iMessage', telegram: 'Telegram', slack: 'Slack', email: 'Email' };
const order = ['desktop', 'imessage', 'telegram', 'slack', 'email'];

const minutes = (ms: number) => `${Math.max(1, Math.floor(ms / 60_000))}m`;

function ReplyGapChip({ gap }: { gap: ReplyGapState }) {
  if (gap.state === 'ok') return null;
  const label = gap.state === 'unknown' ? `${gap.teammate}: reply gap unknown`
    : `${gap.teammate}: ${gap.unansweredCount} unanswered, ${minutes(gap.oldestUnansweredMs)}`;
  return <span role="listitem" aria-label={label} className={leaderStyles.channel} data-state={gap.state}
    style={gap.state === 'late' ? { color: 'var(--color-warning, #b45309)', fontWeight: 600 } : undefined}>{gap.state === 'unknown' ? 'unknown' : label}</span>;
}

export function OwnerChannelsStrip({ channels, paused, replyGap = [] }: { channels: OwnerChannelState[]; paused: boolean; replyGap?: ReplyGapState[] }) {
  if (paused) return <div className={styles.note} role="list" aria-label="Owner channels"><span role="listitem" aria-label="Channels paused" className={leaderStyles.channel}>Channels paused</span></div>;
  if (!channels.length && !replyGap.length) return null;
  const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  return <div className={styles.note} role="list" aria-label="Owner channels" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
    {[...channels].sort((a, b) => rank(a.id) - rank(b.id)).map((channel, index) => {
      const name = Object.hasOwn(names, channel.id) ? names[channel.id] : channel.id;
      const label = `${name} ${channel.enabled ? 'live' : 'off'}`;
      const guidance = channel.nextStep || channel.reason;
      return channel.enabled
        ? <span role="listitem" aria-label={label} className={leaderStyles.channel} key={`${channel.id}-${index}`}>{label}</span>
        : <details role="listitem" aria-label={label} title={guidance} key={`${channel.id}-${index}`}>
          <summary className={leaderStyles.channel}>{label}</summary><span>{guidance}</span>
        </details>;
    })}
    {replyGap.map(gap => <ReplyGapChip gap={gap} key={gap.teammate} />)}
  </div>;
}
