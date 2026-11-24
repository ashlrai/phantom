import type { WorldLaneRow } from './world-lane-rows.js';
import styles from './WorldLaneRows.module.css';

export function BurnSparkline({ history, now = Date.now() }: { history: WorldLaneRow['history']; now?: number }) {
  if (!history || history.points.length < 2) return null;
  const { points, burnPerHour, exhaustAt, resetAt } = history;
  const start = points[0]!.t, span = points.at(-1)!.t - start;
  const segments: string[][] = [];
  for (const p of points) {
    if (!segments.length || p.gapBefore) segments.push([]);
    segments.at(-1)!.push(`${span > 0 ? (p.t - start) / span * 62 + 1 : 1},${15 - Math.max(0, Math.min(1, p.fraction)) * 14}`);
  }
  const marker = burnPerHour !== null && exhaustAt && resetAt && Date.parse(resetAt) > now;
  return <span className={styles.sparkline}>
    <svg width="64" height="16" viewBox="0 0 64 16" role="img" aria-label={`Burn history, ${points.length} measured points`}>
      {segments.map((segment, i) => <polyline key={i} points={segment.join(' ')} fill="none" stroke="currentColor" strokeWidth="1" />)}
    </svg>
    {marker ? <span data-exhaust={Date.parse(exhaustAt) < Date.parse(resetAt) ? 'before-reset' : 'after-reset'}
      aria-label={`Exhaustion ${Date.parse(exhaustAt) < Date.parse(resetAt) ? 'before' : 'after'} reset`}>▴</span> : null}
  </span>;
}
