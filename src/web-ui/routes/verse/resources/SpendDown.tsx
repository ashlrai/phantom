import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpendRow, SpendSnapshot, SpendStatus } from '../../../../core/usage/spend.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from '../SidebarResources.module.css';
import bar from './SpendDown.module.css';

const pct = (n: number | null): string => n === null ? 'unknown' : `${Math.round(n)}%`;
const width = (n: number | null): string => `${Math.min(100, Math.max(0, n ?? 0))}%`;
const amount = (n: number | null, unit: string): string => n === null ? 'unknown' : `${Number(n.toFixed(2))} ${unit}`;
const status: Record<SpendStatus, string> = { 'on-pace': 'on pace', behind: 'behind', exhausted: 'exhausted', unknown: 'unknown' };

/** Used now over projected at reset; an unknown share draws no fill and says "unknown". */
function SpendBar({ row }: { row: SpendRow }) {
  const label = `${pct(row.usedPercent)} used now, ${pct(row.projectedUsedPercent)} projected at reset`;
  return <div className={bar.track} role="img" aria-label={label} data-verdict={row.verdict}>
    {row.projectedUsedPercent !== null ? <span className={bar.projected} style={{ width: width(row.projectedUsedPercent) }} /> : null}
    {row.usedPercent !== null ? <span className={bar.used} style={{ width: width(row.usedPercent) }} /> : null}
  </div>;
}

function UsageDetails({ row }: { row: SpendRow }) {
  const gift = row.unit === 'usd';
  const reset = row.resetAt === null ? NaN : Date.parse(row.resetAt);
  return <dl className={bar.facts}>
    <dt>Used</dt><dd>{pct(row.usedPercent)}</dd>
    <dt>Burn per hour</dt><dd>{amount(row.burnPerHour, gift ? 'USD/h' : '%/h')}</dd>
    <dt>{gift ? 'Unused at expiry' : 'Unused at reset'}</dt>
    <dd>{gift ? amount(row.projectedUnusedUsd, 'USD') : pct(row.projectedUnusedPercent)}</dd>
    <dt>{gift ? 'Expires' : 'Resets'}</dt>
    <dd>{Number.isFinite(reset) ? <time dateTime={row.resetAt!} title={row.resetAt!}>
      {new Date(reset).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </time> : 'unknown'}{row.resetsIn !== null ? <span className={bar.countdown}>in {row.resetsIn}</span> : null}</dd>
    {gift ? <><dt>Balance</dt><dd>{amount(row.remainingUsd, 'USD')}</dd></> : null}
  </dl>;
}

/** Same snapshot as `phm spend --json`: one sentence on top, then the pool that will waste the most first. */
export function SpendDown() {
  const [data, setData] = useState<SpendSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    // Do not keep an old forecast on screen while its replacement is unavailable.
    setData(null);
    setFailed(false);
    void apiGet<SpendSnapshot>('/api/usage/spend', request.signal).then(value => {
      if (!request.signal.aborted) setData(value);
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
  }, []);
  useEffect(() => { refresh(); return () => pending.current?.abort(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section aria-label="Spend down"><h2 className={styles.heading}>Spend down</h2>
    {!data ? <p className={styles.dotRow}>{failed ? 'unknown (status unavailable)' : 'Reading usage…'}</p>
      : data.pools.length === 0 ? <p className={styles.dotRow}>No usage readings yet.</p> : <><p className={bar.headline} role="status">{data.headline}</p><ul className={bar.list}>
      {data.pools.map(row => <li className={styles.dotRow} key={row.pool} aria-label={row.pool}>
        <span className={bar.head}><span className={styles.dotLabel}>{row.unit === 'usd' ? `${row.pool} gift` : row.pool}</span>
          <span className={bar.verdict} data-verdict={row.verdict}>{status[row.status]}</span></span>
        <SpendBar row={row} />
        <UsageDetails row={row} />
        {row.reason !== null ? <span className={styles.note}>{row.reason}</span> : null}
      </li>)}
    </ul></>}
  </section>;
}
