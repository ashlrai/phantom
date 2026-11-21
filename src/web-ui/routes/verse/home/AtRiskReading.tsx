/**
 * The drawing inside Home's "Most at risk of going unused" card: whose allowance it is (provider mark and name),
 * when it resets, the share projected to expire unused as the one figure, and one bar of how the window ends:
 * used now, more by the reset at the measured burn, and the part left over. It draws only the `atRisk` field of
 * the `phm home` summary and reads nothing else; the card keeps its one action in HomePane.
 */
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { atRiskReading, type AtRiskValue } from './at-risk-model.js';
import styles from './at-risk.module.css';

export function AtRiskReading({ risk, now = Date.now() }: { risk: AtRiskValue; now?: number }) {
  const reading = atRiskReading(risk, now);
  return <div className={styles.body}>
    <div className={styles.head}>
      <span className={styles.who} aria-hidden="true"><ProviderBadge of={reading.resource} iconOnly size={14} /><span className={styles.name}>{reading.resource}</span></span>
      {/* A reset that is not ahead is said in words and marked as no reading, never counted down. */}
      <span className={styles.when} data-unknown={reading.resetAhead ? undefined : true}>{reading.when}</span>
    </div>
    <div className={styles.figure} aria-hidden="true"><strong>{reading.figure}</strong>would expire unused</div>
    {/* The sentence `phm home` prints; the mark, figure and bar around it repeat it. */}
    <span className="visually-hidden">{`${risk.resource}. ${risk.reason}`}</span>
    <span role="meter" className={styles.bar} aria-label={`${reading.resource} used by its reset`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading.usedByReset} aria-valuetext={reading.words}>
      {reading.parts.map(part => <i key={part.kind} data-part={part.kind} style={{ width: `${part.percent}%` }} />)}
    </span>
    <ul className={styles.key} aria-label="How this window ends">
      {reading.parts.map(part => <li key={part.kind} data-part={part.kind}>{part.words}</li>)}
    </ul>
  </div>;
}
