/**
 * routes/verse/fleet-pools/FleetPoolsPane.tsx — the Pools board: every resource as one row with its bar and its
 * labelled readings (used, left, reset, burn, unused at reset, running jobs, when it was read; a balance for credits), narrowed
 * by state from the keyboard. Rows, order and wording come from GET /api/app/pools (pools.v1), the same view
 * `phm pools` prints, so the pane decides nothing an agent cannot read.
 */
import { useState } from 'react';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { localTime, PoolItem } from './PoolItem.js';
import { nextReset, poolCounts, poolGroup, poolsHeadline, span, type PoolFilter } from './pools-board-model.js';
import { fleetPoolsQuery } from './pools-query.js';
import styles from './fleet-pools.module.css';

export { fleetPoolsQuery };

const FILTERS: readonly { value: PoolFilter; word: string; none: string }[] = [
  { value: 'all', word: 'All', none: '' },
  { value: 'behind', word: 'Behind', none: 'No pool is behind.' },
  { value: 'pace', word: 'On pace', none: 'No pool is known to be on pace.' },
  { value: 'unknown', word: 'Unknown', none: 'Every pool has a current reading.' },
];

export function FleetPoolsPane({ visible }: PaneProps) {
  const [filter, setFilter] = useState<PoolFilter>('all');
  const read = useQuery(fleetPoolsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetPoolsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  const view = read.data;
  if (!view) return <p className={styles.message} role="status">{read.status === 'error' ? 'Pools are unavailable.' : 'Reading pools…'}</p>;
  const counts = poolCounts(view.pools);
  const shown = filter === 'all' ? view.pools : view.pools.filter(row => poolGroup(row) === filter);
  const next = nextReset(view);
  const stale = read.status === 'error';
  return <section className={styles.root} aria-label="Pools">
    <p className={styles.headline}>{poolsHeadline(view.pools)}</p>
    {/* A failed refresh keeps the last reading on screen; it must not read as current. */}
    {stale ? <p className={styles.meta} data-stale role="alert">Could not refresh. Showing the reading from {localTime(view.generatedAt)}.</p> : null}
    {view.pools.length > 0 ? <>
      <p className={styles.meta}>{next ? `Next reset: ${next.id} in ${span(next.hours)}.` : 'Next reset unknown.'}{stale ? '' : ` Read ${localTime(view.generatedAt)}.`}</p>
      <Segmented size="sm" aria-label="Show pools" value={filter} onChange={setFilter}
        options={FILTERS.map(({ value, word }) => ({ value, label: `${word} ${counts[value]}` }))} />
      {shown.length > 0 ? <ul className={styles.list} aria-label="Pools list">{shown.map(row => <PoolItem key={row.id} row={row} view={view} />)}</ul>
        : <p className={styles.message} role="status">{FILTERS.find(item => item.value === filter)!.none}</p>}
      <p className={styles.message}>Bar: used so far. Lighter: where this burn ends by reset. Marker: time elapsed in the window. A bar short of the marker is behind. Same data: <code>phm pools</code>.</p>
    </> : null}
    {view.gaps.map(gap => <p key={gap} className={styles.message}>Not covered: {gap}</p>)}
  </section>;
}
