import { useCallback, useEffect, useState } from 'react';
import type { SpendSnapshot } from '../../../../core/usage/spend.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from '../SidebarResources.module.css';

/** Live spend-down section: reads once on mount, then polls while visible. */
export function SpendDown() {
  const [data, setData] = useState<SpendSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    void apiGet<SpendSnapshot>('/api/usage/spend').then(value => { setData(value); setFailed(false); }).catch(() => { setData(null); setFailed(true); });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section aria-label="Spend down"><h2 className={styles.heading}>Spend down</h2>
    {!data ? <p className={styles.dotRow}>{failed ? 'unknown (status unavailable)' : 'Reading usage…'}</p> : data.pools.map(row =>
      <div className={styles.dotRow} key={row.pool}><span className={styles.dotLabel}>{row.pool}</span>
        <span className={styles.note}>{row.reason ? `unknown (${row.reason})` : `${row.usedPercent}% used · reset ${new Date(row.resetAt!).toLocaleString()} · ${row.hoursLeft!.toFixed(1)} hours left · ${row.burnPerHour}% per hour · ${row.projectedUnusedPercent!.toFixed(1)}% unused at reset`}</span></div>)}
  </section>;
}
