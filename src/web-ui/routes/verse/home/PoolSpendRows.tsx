import { poolLabel, poolSpendLine, type PoolShareSnapshot } from '../../../../core/usage/runway.js';
import { WindowBar } from '../../../components/primitives/WindowBar.js';
import styles from './pools-card.module.css';

/** Desktop and phone use the CLI's rows; the existing runway refresh supplies them. */
export function PoolSpendRows({ data, select, selected, regionId }: { data: PoolShareSnapshot; select: (pool: string) => void; selected: string | null; regionId: string }) {
  return <><ul className={styles.spend}>{data.pools.map(row => {
    const used = row.used_percent === null ? null : Math.min(100, row.used_percent);
    const end = row.projected_percent_at_reset;
    const label = `${poolLabel(row.pool)}${row.unit === 'usd' ? ' gift' : ''}`;
    const pct = (n: number | null) => n === null ? 'unknown' : `${n}%`;
    return <li key={row.pool}>
      <button type="button" className={styles.pool} aria-label={poolSpendLine(row)} aria-expanded={selected === row.pool}
        aria-controls={selected === row.pool ? regionId : undefined} onClick={() => select(row.pool)}>
        <strong>{label}: {row.verdict}</strong><span className={styles.detail}>{pct(row.used_percent)} used · {pct(row.burn_pct_per_hour)}/h · {pct(end)} at reset</span>
        <span className={styles.detail} title={row.reset_at ?? undefined}>{row.unit === 'usd' ? 'Expires' : 'Resets'} in {row.hours_to_reset === null ? 'an unknown time' : `${row.hours_to_reset} h`}</span>
      </button>
      <div className={styles.resetBar}><WindowBar label={`${label} used`} valueText={poolSpendLine(row)} valueNow={used}
        used={used} more={end === null || used === null ? null : Math.max(0, end - used)}
        unused={end === null ? null : 100 - end} ending={row.state === 'starving' ? 'dry' : undefined} />
        {row.reset_at !== null ? <i className={styles.resetMark} aria-label={`${label} ${row.unit === 'usd' ? 'expiry' : 'reset'}: ${row.reset_at}`} /> : null}</div>
    </li>;
  })}</ul><p className={styles.hint}>Solid: used. Light: more by reset. Right mark: reset or expiry. Choose a pool for running jobs.</p></>;
}
