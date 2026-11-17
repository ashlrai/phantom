import { useCallback, useEffect, useState } from 'react';
import type { SpendRow, SpendSnapshot } from '../../../../core/usage/spend.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from '../SidebarResources.module.css';
import bar from './SpendDown.module.css';

const pct = (n: number | null): string => n === null ? 'unknown' : `${Math.round(n)}%`;
const width = (n: number | null): string => `${Math.min(100, Math.max(0, n ?? 0))}%`;

/** Used now over projected at reset; an unknown share draws no fill and says "unknown". */
function SpendBar({ row }: { row: SpendRow }) {
  const label = `${pct(row.usedPercent)} used now, ${pct(row.projectedUsedPercent)} projected at reset`;
  return <div className={bar.track} role="img" aria-label={label} data-verdict={row.verdict}>
    {row.projectedUsedPercent !== null ? <span className={bar.projected} style={{ width: width(row.projectedUsedPercent) }} /> : null}
    {row.usedPercent !== null ? <span className={bar.used} style={{ width: width(row.usedPercent) }} /> : null}
  </div>;
}

function detail(row: SpendRow): string {
  const left = row.resetsIn === null ? 'unknown' : `in ${row.resetsIn}`;
  if (row.unit === 'usd') return `${row.remainingUsd === null ? 'balance unknown' : `${row.remainingUsd} USD left`} · expires ${left}`;
  return `${pct(row.usedPercent)} used · ${pct(row.projectedUsedPercent)} by reset · resets ${left}`;
}

/** Spend down: one row per pool from `phm fleet spend --json`, behind first. Reads on mount, then polls while visible. */
export function SpendDown() {
  const [data, setData] = useState<SpendSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    void apiGet<SpendSnapshot>('/api/usage/spend').then(value => { setData(value); setFailed(false); }).catch(() => { setData(null); setFailed(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section aria-label="Spend down"><h2 className={styles.heading}>Spend down</h2>
    {!data ? <p className={styles.dotRow}>{failed ? 'unknown (status unavailable)' : 'Reading usage…'}</p> : <ul className={bar.list}>
      {data.pools.map(row => <li className={styles.dotRow} key={row.pool} aria-label={row.pool}>
        <span className={bar.head}><span className={styles.dotLabel}>{row.pool}</span>
          <span className={bar.verdict} data-verdict={row.verdict}>{row.summary}</span></span>
        <SpendBar row={row} />
        <span className={styles.note}>{detail(row)}</span>
      </li>)}
    </ul>}
  </section>;
}
