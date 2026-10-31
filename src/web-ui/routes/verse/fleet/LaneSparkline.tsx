import type { FleetEngine } from '../../../../core/fleet/fleet-types.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { describeLane, summariseLane, useLaneHistory } from './lane-history-store.js';
import styles from './lane-sparkline.module.css';

export function LaneSparkline({ lane }: { lane: FleetEngine }) {
  const samples = useLaneHistory(lane);
  const summary = summariseLane(samples, Date.now());
  if (!summary) return null;
  const off = samples[samples.length - 1]!.slots === 0;
  const label = `${describeLane(lane, summary)}${off ? ', lane off' : ''}`;
  return (
    <span className={`${styles.trend} ${off ? styles.muted : ''}`}>
      <Sparkline points={summary.points} width={56} height={14} ariaLabel={label} describe={(value) => `${value} busy`} />
    </span>
  );
}
