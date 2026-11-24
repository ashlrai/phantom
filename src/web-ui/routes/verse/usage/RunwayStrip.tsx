import { useCallback, useEffect, useRef, useState } from 'react';
import { isRunwaySnapshot, type PoolRunway, type RunwaySnapshot, type RunwayState } from '../../../../core/usage/runway.js';
import { apiGet } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './RunwayStrip.module.css';

const label: Record<RunwayState, string> = { starve: 'STARVE', spend: 'SPEND', pace: 'PACE', unknown: 'unknown' };
const hours = (n: number | null): string => n === null ? 'unknown' : `${Math.round(n)}h`;

/** "97% used · empty in 3h · reset in 59h" — every number, or the word unknown. */
function facts(row: PoolRunway): string {
  const used = row.usedPercent === null ? 'used unknown' : `${Math.round(row.usedPercent)}% used`;
  const empty = row.state !== 'unknown' && row.hoursToEmpty === null ? 'not draining' : `empty in ${hours(row.hoursToEmpty)}`;
  return `${used} · ${empty} · reset in ${hours(row.hoursToReset)}`;
}

/**
 * One line per pool: will it last until reset at today's burn? Red when it
 * will run dry first. Same snapshot as `phm pool runway --json`.
 */
export function RunwayStrip() {
  const [data, setData] = useState<RunwaySnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setFailed(false);
    void apiGet<unknown>('/api/usage/runway', request.signal).then(value => {
      if (request.signal.aborted) return;
      // An older host or a proxy may answer with another shape: say unknown rather than draw it.
      if (isRunwaySnapshot(value)) setData(value); else { setData(null); setFailed(true); }
    }).catch(() => { if (!request.signal.aborted) { setData(null); setFailed(true); } });
  }, []);
  useEffect(() => { refresh(); return () => pending.current?.abort(); }, [refresh]);
  usePollWhileVisible(refresh, 60_000);
  return <section className={styles.strip} aria-labelledby="verse-usage-runway">
    <h3 id="verse-usage-runway" className={styles.title}>Runway</h3>
    {!data ? <p className={styles.note}>{failed ? 'unknown (status unavailable)' : 'Reading runway…'}</p> : <>
      <p className={styles.headline} role="status">{data.headline}</p>
      <ul className={styles.list}>
        {data.pools.map(row => <li key={row.pool} className={styles.row} data-state={row.state} aria-label={`${row.pool} ${label[row.state]}`}>
          <span className={styles.pool}>{row.pool}</span>
          <span className={styles.state}>{label[row.state]}</span>
          <span className={styles.facts}>{facts(row)}</span>
          <span className={styles.advice}>{row.advice}</span>
        </li>)}
      </ul>
    </>}
  </section>;
}
