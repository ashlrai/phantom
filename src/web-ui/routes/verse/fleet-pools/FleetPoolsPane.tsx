/**
 * routes/verse/fleet-pools/FleetPoolsPane.tsx — the Pools board: one line of time with every plan pool's runway to
 * its reset (PoolRunway), then every resource as one row with its bar, its window
 * so far (the stored readings from GET /api/verse/leader/resources/usage-history, `phm fleet usage-history`) and its
 * labelled readings (used, left, reset, burn, unused at reset, running jobs, when it was read; a balance for credits), narrowed
 * by state from the keyboard. Rows, order and wording come from GET /api/app/pools (pools.v1), the same view
 * `phm pools` prints, so the pane decides nothing an agent cannot read.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { localTime, PoolItem, type PoolWindows } from './PoolItem.js';
import { PoolRunway } from './PoolRunway.js';
import { poolRunway } from './pool-runway-model.js';
import { poolWindowsQuery } from './pool-window-query.js';
import { fleetPoolsQuery } from './pools-query.js';
import { nextReset, poolCounts, poolGroup, poolsHeadline, span, type PoolFilter } from './pools-board-model.js';
import styles from './fleet-pools.module.css';

export { fleetPoolsQuery };

const FILTERS: readonly { value: PoolFilter; word: string; none: string }[] = [
  { value: 'all', word: 'All', none: '' },
  { value: 'fast', word: 'Too fast', none: 'No pool is running out early.' },
  { value: 'behind', word: 'Behind', none: 'No pool is behind.' },
  { value: 'pace', word: 'On pace', none: 'No pool is known to be on pace.' },
  { value: 'unknown', word: 'Unknown', none: 'Every pool has a current reading.' },
];

export function FleetPoolsPane({ visible }: PaneProps) {
  const [filter, setFilter] = useState<PoolFilter>('all');
  const read = useQuery(fleetPoolsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetPoolsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  // Each card's window so far. The route takes a ledger reading per call, so it is asked once a minute, like the sidebar.
  const history = useQuery(poolWindowsQuery, { enabled: visible, freshMs: 0 });
  const refetchHistory = useRefetch(poolWindowsQuery);
  usePollWhileVisible(refetchHistory, 60_000, { enabled: visible });
  const view = read.data;
  const runway = useMemo(() => view ? poolRunway(view, localTime) : null, [view]);
  // A pool chosen on the Runway line: its card is brought into view and takes the keyboard, once it is on screen.
  const root = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState<{ pool: string } | null>(null);
  useEffect(() => {
    if (!chosen) return;
    const card = [...root.current?.querySelectorAll<HTMLElement>('[data-pool]') ?? []].find(item => item.dataset.pool === chosen.pool);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView?.({ block: 'nearest' });
  }, [chosen]);
  if (!view) return <p className={styles.message} role="status">{read.status === 'error' ? 'Pools are unavailable.' : 'Reading pools…'}</p>;
  const counts = poolCounts(view.pools);
  const shown = filter === 'all' ? view.pools : view.pools.filter(row => poolGroup(row) === filter);
  // A card the state switch has hidden is shown again before it takes the keyboard.
  const showCard = (pool: string) => { if (!shown.some(row => row.id === pool)) setFilter('all'); setChosen({ pool }); };
  const next = nextReset(view);
  const stale = read.status === 'error';
  const readAt = Date.parse(history.data?.generated_at ?? '');
  const windows: PoolWindows = { read: history.data ? 'ready' : history.status === 'error' ? 'failed' : 'loading',
    now: Number.isFinite(readAt) ? readAt : Date.now(), pools: history.data?.pools ?? [] };
  return <section ref={root} className={styles.root} aria-label="Pools">
    <p className={styles.headline}>{poolsHeadline(view.pools)}</p>
    {/* A failed refresh keeps the last reading on screen; it must not read as current. */}
    {stale ? <p className={styles.meta} data-stale role="alert">Could not refresh. Showing the reading from {localTime(view.generatedAt)}.</p> : null}
    {view.pools.length > 0 ? <>
      <p className={styles.meta}>{next ? `Next reset: ${next.id} in ${span(next.hours)}.` : 'Next reset unknown.'}{stale ? '' : ` Read ${localTime(view.generatedAt)}.`}</p>
      {runway ? <PoolRunway runway={runway} onShow={showCard} /> : null}
      <Segmented size="sm" aria-label="Show pools" value={filter} onChange={setFilter}
        options={FILTERS.map(({ value, word }) => ({ value, label: `${word} ${counts[value]}` }))} />
      {shown.length > 0 ? <ul className={styles.list} aria-label="Pools list">{shown.map(row => <PoolItem key={row.id} row={row} view={view} windows={windows} />)}</ul>
        : <p className={styles.message} role="status">{FILTERS.find(item => item.value === filter)!.none}</p>}
      {/* Said once here, not on every card: without the stored readings a card still shows its latest reading. */}
      {windows.read === 'failed' && view.pools.some(row => row.kind === 'subscription')
        ? <p className={styles.message} data-windows="failed">The stored readings could not be read, so no card draws its window. Each card still shows its latest reading.</p> : null}
      <p className={`${styles.message} ${styles.key}`} data-bar-key>
        <span><WindowBarSwatch part="used" />used so far</span>
        <span><WindowBarSwatch part="more" />more by its reset at this burn</span>
        <span><WindowBarSwatch part="unused" />left unused at its reset</span>
        <span><WindowBarSwatch part="elapsed" />time elapsed in the window</span>
        <span>A bar short of the time mark is behind; an amber bar runs dry early. Same data: <code>phm pools</code>.</span>
      </p>
      <p className={styles.message}>Chart: every stored reading from the window&apos;s start to its reset. Dashed: the even line from 0% to 100%. Dotted: where this burn leads. Point at a chart, or focus it and press Left or Right, to read one reading at a time. Same data: <code>phm fleet usage-history</code>.</p>
    </> : null}
    {view.gaps.map(gap => <p key={gap} className={styles.message}>Not covered: {gap}</p>)}
  </section>;
}
