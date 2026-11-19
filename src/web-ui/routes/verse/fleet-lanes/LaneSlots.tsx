/**
 * The slot marks on the Lanes board: one square per slot of a lane (running, running beyond the target, open), a bar
 * for a lane too large to count by eye, and the strip that lays every lane's slots end to end. Draws only what the
 * lane card holds; the caption beside it carries the same numbers as text.
 */
import type { CSSProperties } from 'react';
import type { LaneCard, StripSegment } from './lanes-board-model.js';
import styles from './fleet-lanes.module.css';

export function LaneSlots({ card }: { card: LaneCard }) {
  const label = `${card.lane}: ${card.running} running of ${card.target} target`;
  if (card.pips) return <div className={styles.pips} role="img" aria-label={label}>
    {card.pips.map((pip, i) => <span key={i} className={styles.pip} data-pip={pip} />)}
  </div>;
  // No slots asked for and none running: nothing to draw, and an empty track would read as "0 of something".
  if (card.fillPct === null) return null;
  return <div className={styles.track} role="img" aria-label={label}>
    <div className={styles.fill} style={{ width: `${card.fillPct}%` }} />
  </div>;
}

export function FleetStrip({ segments, label }: { segments: readonly StripSegment[]; label: string }) {
  return <div className={styles.strip} role="img" aria-label={label}>
    {segments.map(segment => <span key={segment.lane} className={styles.segment} data-state={segment.state}
      title={segment.lane} style={{ flexGrow: segment.weight } as CSSProperties}>
      <span className={styles.segmentFill} style={{ width: `${segment.fillPct}%` }} />
    </span>)}
  </div>;
}
