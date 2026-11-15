import leaderStyles from '../leader/leader.module.css';
import type { ReplyGapState } from './owner-thread-queries.js';

const minutes = (ms: number) => `${Math.max(1, Math.floor(ms / 60_000))}m`;

/** Warning chip for an unanswered teammate text. Nothing when answered in time. */
export function ReplyGapChip({ gap }: { gap: ReplyGapState }) {
  if (gap.state === 'ok') return null;
  const label = gap.state === 'unknown' ? `${gap.teammate}: reply gap unknown`
    : `${gap.teammate}: ${gap.unansweredCount} unanswered, ${minutes(gap.oldestUnansweredMs)}`;
  return <span role="listitem" aria-label={label} className={leaderStyles.channel} data-state={gap.state}
    style={gap.state === 'late' ? { color: 'var(--color-warning, #b45309)', fontWeight: 600 } : undefined}>{gap.state === 'unknown' ? 'unknown' : label}</span>;
}
