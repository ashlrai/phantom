import { SPENDDOWN_SCHEMA, type SpendDownRow, type SpendDownV1 } from '../../../../core/fleet/pools-spenddown.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './SpendDownChart.module.css';

/** GET /api/app/pools/spenddown as a cached query, shared by the desktop usage panel and the phone Home card. */
export const spendDownQuery: QueryDef<SpendDownV1> = {
  key: 'app-pools-spenddown',
  fetch: async signal => {
    const data = await apiGet<SpendDownV1>('/api/app/pools/spenddown', signal);
    // A drifted payload is loud, not a blank chart.
    if (data?.schema !== SPENDDOWN_SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${SPENDDOWN_SCHEMA}`);
    return data;
  },
};

const pct = (frac: number | null): string => frac === null ? 'unknown' : `${Math.round(frac * 100)}%`;
const left = (frac: number): string => `${Math.min(100, Math.max(0, frac * 100))}%`;

/** "resets in 22 h"; days past two, "soon" under an hour; nothing when the reset is unknown. */
export function resetsInText(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return 'resets soon';
  return hours < 48 ? `resets in ${Math.round(hours)} h` : `resets in ${Math.round(hours / 24)} d`;
}

function describe(row: SpendDownRow): string {
  if (row.used_frac === null) return `${row.label}: ${row.verdict}`;
  return `${row.label}: ${pct(row.used_frac)} used, even pace ${pct(row.even_pace_frac)}, ends near ${pct(row.projected_at_reset)} at reset. ${row.verdict}`;
}

/** Reads only pools.spenddown.v1: nothing is derived here, an unknown share draws no fill, tick or marker. */
export function SpendDownChart({ data }: { data: SpendDownV1 }) {
  if (data.pools.length === 0) return null;
  return <div className={styles.chart} data-testid="spenddown-chart">
    {data.pools.map(row => <div className={styles.row} key={row.id} data-state={row.state}>
      <div className={styles.head}><span className={styles.label}>{row.label}</span><span className={styles.verdict}>{row.verdict}</span></div>
      {resetsInText(row.resets_in_h) ? <span className={styles.reset}>{resetsInText(row.resets_in_h)}</span> : null}
      <div className={styles.track} role="img" aria-label={describe(row)}>
        {row.used_frac !== null ? <span className={styles.used} style={{ width: left(row.used_frac) }} /> : null}
        {row.used_frac !== null && row.even_pace_frac !== null ? <span className={styles.pace} data-mark="even-pace" style={{ left: left(row.even_pace_frac) }} /> : null}
        {row.used_frac !== null && row.projected_at_reset !== null ? <span className={styles.projected} data-mark="projected" style={{ left: left(row.projected_at_reset) }} /> : null}
      </div>
    </div>)}
    <p className={styles.key}>Bar: used. Line: even pace. Diamond: where it ends at reset.</p>
  </div>;
}
