import leaderStyles from '../leader/leader.module.css';
import type { ReplyGapState } from './owner-thread-queries.js';

const minutes = (ms: number) => `${Math.max(1, Math.floor(ms / 60_000))}m`;

/** Warning chip for an unanswered teammate text. Nothing when answered in time. */
export function ReplyGapChip({ gap }: { gap: ReplyGapState }) {
  if (gap.state === 'ok') return null;
  const label = gap.state === 'unknown' ? `${gap.teammate}: reply gap unknown`
    : `${gap.teammate}: ${gap.unansweredCount} unanswered, ${minutes(gap.oldestUnansweredMs)}`;
  // Tone comes from data-state in leader-thread.module.css (the old inline colour named a token that does not exist).
  return <span role="listitem" aria-label={label} className={leaderStyles.channel} data-state={gap.state}>{gap.state === 'unknown' ? 'unknown' : label}</span>;
}
