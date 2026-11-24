/**
 * LaneHealthBadge: the lane's one verdict (ok, held, starved, wasteful,
 * drained) as a colored pill; hover or focus shows the plain reason with the
 * number behind it. Shared by the 2D map, the 3D map and the lane card so
 * they cannot disagree. Renders nothing when the server sent no verdict.
 */
import type { LaneHealth } from '../../../core/fleet/lane-badge.js';
import styles from './LaneHealthBadge.module.css';

export function LaneHealthBadge({ health }: { health?: LaneHealth | null }) {
  if (!health) return null;
  const tip = health.emptyNote ? `${health.reason}. ${health.emptyNote}` : health.reason;
  return (
    <span className={styles.badge} data-state={health.state} data-testid="lane-health" role="img"
      title={tip} aria-label={tip}>
      {health.state}
    </span>
  );
}
