/** The `phm metrics leverage` report as one tile: the fleet plus product share, a per-hour trend, and counts per class. */
import type { LeverageReport } from '../../../../core/metrics/leverage-class.js';
import { MERGE_CLASSES } from '../../../../core/metrics/leverage-class.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import styles from './fleet-metrics.module.css';

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** `report` is undefined while loading or when the server predates the report: the tile then reads unknown. */
export function LeverageTile({ report }: { report: LeverageReport | undefined }) {
  const usable = report?.schema === 'metrics.leverage.v1' && report.known && report.totals && report.perHour ? report : undefined;
  const hourly = usable?.perHour?.map(({ counts }) => {
    const all = MERGE_CLASSES.reduce((sum, name) => sum + counts[name], 0);
    return all ? (counts.fleet + counts.product) / all : null;
  });
  return <div className={styles.card}>
    <h3 className={styles.heading}>Merge leverage</h3>
    {!usable ? <p className={styles.note}>Merge leverage: unknown</p>
      : !usable.total ? <p className={styles.note}>No merges in the last {usable.hours} hours</p>
      : <>
        <p className={styles.note}>{percent(usable.leverageShare!)} of {usable.total} merges in the last {usable.hours} hours moved the fleet or the product.</p>
        {usable.sources.jobsTruncated ? <p className={styles.note}>Jobs ledger truncated: counts cover only its newest window.</p> : null}
        <Sparkline points={hourly!} ariaLabel="Fleet and product share of merges per hour" />
        <p className={styles.note}>{MERGE_CLASSES.map(name => `${name} ${usable.totals![name]}`).join(' · ')}</p>
      </>}
  </div>;
}
