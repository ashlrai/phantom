import { useEffect } from 'react';
import type { ResourceView } from '../../../core/fabric/resource-view.js';
import { apiGet } from '../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../data/hooks.js';
import type { QueryDef } from '../../data/queries.js';
import styles from './ResourcePanel.module.css';

export const resourceViewQuery: QueryDef<ResourceView> = {
  key: 'resource-view', fetch: signal => apiGet<ResourceView>('/api/resource', signal),
};
const pct = (value: number | null) => value === null ? 'unknown' : `${value.toFixed(1)}%`;
const date = (value: string | null) => value === null ? 'unknown' : new Date(value).toLocaleString();

/** Both fleet surfaces read the same file projection; no client-side quota or admission math. */
export function ResourcePanel() {
  const query = useQuery(resourceViewQuery);
  const refresh = useRefetch(resourceViewQuery);
  const manualRefresh = useRefresh(resourceViewQuery);
  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const view = query.data;
  return <section className={styles.panel} aria-label="Resource capacity">
    <header className={styles.header}><h2>Resource capacity</h2><button type="button" onClick={manualRefresh}>Refresh</button></header>
    {query.status === 'error' ? <p role="alert">Resource capacity unavailable. Last readings are not current.</p>
      : !view ? <p role="status">Loading resource capacity...</p> : <>
        <div className={styles.scroll}><table>
          <caption>Pool usage and pace to each reset</caption>
          <thead><tr><th scope="col">Pool</th><th scope="col">Status</th><th scope="col">Used</th><th scope="col">Burn / hour</th><th scope="col">Pace</th><th scope="col">Reset</th><th scope="col">Exhaustion estimate</th></tr></thead>
          <tbody>{view.pools.map(pool => <tr key={pool.pool}>
            <th scope="row">{pool.pool}<small>{pool.source ?? 'No reading'} · {date(pool.fetchedAt)}</small></th>
            <td><span data-status={pool.status}>{pool.status}</span></td><td>{pct(pool.pctUsed)}</td>
            <td>{pool.burnRatePerHour === null ? 'unknown' : `${pool.burnRatePerHour.toFixed(2)} pp`}</td>
            <td>{pool.paceRatio === null ? 'unknown' : `${pool.paceRatio.toFixed(2)}x`}</td>
            <td>{date(pool.resetAt)}</td><td>{pool.projectedExhaustionAt === null && pool.burnRatePerHour === 0 && pool.status === 'green' ? 'No burn observed' : date(pool.projectedExhaustionAt)}</td>
          </tr>)}</tbody>
        </table></div>
        <dl className={styles.machine}>
          <div><dt>Memory free</dt><dd>{pct(view.machine.memFreePct)}</dd></div>
          <div><dt>Swap used</dt><dd>{pct(view.machine.swapUsedPct)}</dd></div>
          <div><dt>Disk free</dt><dd>{pct(view.machine.diskFreePct)}</dd></div>
          <div><dt>Machine admission</dt><dd>{view.machine.admission}</dd></div>
          <div><dt>Local models</dt><dd>{view.localModels.count ?? 'unknown'}</dd></div>
        </dl>
        <p className={styles.note}>Pace above 1x exhausts the pool before its reset. Estimates use observed burn; admission controls still apply.</p>
      </>}
  </section>;
}
