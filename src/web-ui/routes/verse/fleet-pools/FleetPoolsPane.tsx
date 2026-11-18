/**
 * routes/verse/fleet-pools/FleetPoolsPane.tsx — one bar per resource: used
 * against time elapsed in its window, with a plain-words line. Rows, order and
 * wording come from GET /api/app/pools (pools.v1), the same view `phm pools`
 * prints, so the pane decides nothing an agent cannot read.
 */
import { POOLS_PATH, POOLS_SCHEMA, type PoolRow, type PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-pools.module.css';

export const fleetPoolsQuery: QueryDef<PoolsViewV1> = {
  key: 'app-pools',
  fetch: async signal => {
    const data = await apiGet<PoolsViewV1>(POOLS_PATH, signal);
    // A drifted payload is loud, not a blank list.
    if (data?.schema !== POOLS_SCHEMA || !Array.isArray(data.pools)) throw new Error(`Expected ${POOLS_SCHEMA}`);
    return data;
  },
};

const localTime = (iso: string | null): string => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
};

function PoolBar({ row }: { row: PoolRow }) {
  if (row.usedPct === null) return <div className={styles.track} data-unknown role="img" aria-label={`${row.id} usage unknown`} />;
  const label = `${row.id}: ${row.usedPct}% used${row.elapsedPct === null ? '' : `, ${row.elapsedPct}% of the window elapsed`}`;
  return <div className={styles.track} role="img" aria-label={label}>
    <span className={styles.fill} style={{ width: `${row.usedPct}%` }} />
    {row.elapsedPct === null ? null : <span className={styles.marker} style={{ left: `${row.elapsedPct}%` }} />}
  </div>;
}

function PoolItem({ row }: { row: PoolRow }) {
  return <li className={styles.row} data-risk={row.wasteRisk} aria-label={`${row.id} pool`}>
    <div className={styles.head}><strong>{row.id}</strong><span className={styles.summary}>{row.summary}</span></div>
    <PoolBar row={row} />
    <p className={styles.facts}>
      {row.usedPct === null ? 'Used unknown' : `${row.usedPct}% used`}
      {row.hoursLeft === null ? null : ` · resets ${localTime(row.resetAt)} (${row.hoursLeft} h left)`}
      {row.burnPctPerHour === null ? null : ` · ${row.burnPctPerHour}%/h`}
      {` · read ${localTime(row.asOf)}`}
    </p>
  </li>;
}

export function FleetPoolsPane({ visible }: PaneProps) {
  const read = useQuery(fleetPoolsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetPoolsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  const view = read.data;
  if (!view) return <p className={styles.message} role="status">{read.status === 'error' ? 'Pools are unavailable.' : 'Reading pools…'}</p>;
  const unknown = view.pools.filter(row => row.wasteRisk === 'unknown').length;
  const behind = view.pools.filter(row => row.wasteRisk === 'high' || row.wasteRisk === 'medium').length;
  const headline = view.pools.length === 0 ? 'No resources reported.'
    : unknown === view.pools.length ? 'No current reading for any resource. Nothing here is known to be on pace.'
      : `${behind === 0 ? 'Nothing is behind' : `${behind} behind`}${unknown ? `, ${unknown} unknown` : ''}.`;
  return <section className={styles.root} aria-label="Pools">
    <p className={styles.headline}>{headline}</p>
    {read.status === 'error' ? <p className={styles.message} role="alert">Could not refresh. Showing the reading from {localTime(view.generatedAt)}.</p> : null}
    <ul className={styles.list}>{view.pools.map(row => <PoolItem key={row.id} row={row} />)}</ul>
    <p className={styles.message}>Bar: used so far. Marker: time elapsed in the window. A bar short of the marker is behind. Same data: <code>phm pools</code>.</p>
    {view.gaps.map(gap => <p key={gap} className={styles.message}>Not covered: {gap}</p>)}
  </section>;
}
