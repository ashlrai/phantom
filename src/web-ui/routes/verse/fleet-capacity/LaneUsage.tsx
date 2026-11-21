/**
 * The usage window on a Capacity card: how much of the lane's allowance is used and when it resets, drawn on the bar
 * the Pools board draws (components/primitives/WindowBar.tsx), under the slots the lane filled. One read of
 * GET /api/app/pools (`phm pools`) feeds every card through the cache entry the Pools board and Home already share.
 */
import type { PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { fleetPoolsQuery } from '../fleet-pools/pools-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { clock } from './LaneCapacityCard.js';
import { anyMeasured, laneUsage, type LaneIdle, type PoolsRead } from './lane-usage-model.js';
import styles from './lane-usage.module.css';

export interface LanePools { view: PoolsViewV1 | undefined; read: PoolsRead; refresh: () => void }

/** The pools view for the board: read when the pane is showing, again each minute while it stays visible. */
export function useLanePools(active: boolean, visible: boolean): LanePools {
  const entry = useQuery(fleetPoolsQuery, { enabled: active });
  const refetch = useRefetch(fleetPoolsQuery);
  const refresh = useRefresh(fleetPoolsQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  const failed = entry.status === 'error';
  return { view: entry.data, read: entry.data ? (failed ? 'stale' : 'ok') : failed ? 'failed' : 'loading', refresh };
}

const localTime = (iso: string): string => clock(Date.parse(iso));

export function LaneUsage({ lane, pools, hours, onOpen }: { lane: LaneIdle; pools: LanePools; hours: number; onOpen?: () => void }) {
  const usage = laneUsage(lane, pools.view, pools.read, hours, localTime);
  const title = onOpen
    ? <button type="button" className={styles.open} aria-label={`Usage window: open ${lane.lane} in Pools`} onClick={onOpen}>Usage window</button>
    : <span>Usage window</span>;
  if (usage === null) return <div className={styles.usage} data-testid="lane-usage" data-usage="reading"><div className={styles.head}><span className={styles.title}>{title}</span><span className={styles.figure} role="status">Reading usage…</span></div></div>;
  const resetMs = usage.resetAt === null ? NaN : Date.parse(usage.resetAt);
  return <div className={styles.usage} data-testid="lane-usage" data-usage={usage.kind}>
    <div className={styles.head}>
      <span className={styles.title}>{title}</span>
      <span className={styles.figure}>
        <b data-unknown={usage.kind === 'unknown' || undefined}>{usage.figure}</b>
        {/* The reset leads the qualifiers, so its local time sits beside it. */}
        {usage.meta.map((part, index) => <span key={part}> · {part}{index === 0 && Number.isFinite(resetMs) ? <> (<time dateTime={new Date(resetMs).toISOString()}>{clock(resetMs)}</time>)</> : null}</span>)}
      </span>
    </div>
    {usage.bar ? <WindowBar label={`${lane.lane} usage window`} valueText={usage.bar.words} valueNow={usage.bar.used} used={usage.bar.used}
      more={usage.bar.more} unused={usage.bar.unused} elapsed={usage.bar.elapsed} ending={usage.bar.ending} /> : null}
    {usage.note ? <p className={styles.note} data-tone={usage.tone}>{usage.note}</p> : null}
  </div>;
}

/** What the parts of the usage bar mean, said once above the cards; nothing when no card has a measured window. */
export function LaneUsageKey({ lanes, pools }: { lanes: readonly string[]; pools: LanePools }) {
  if (!anyMeasured(lanes, pools.view)) return null;
  return <p className={styles.key} data-testid="lane-usage-key">
    Usage window, from <code>phm pools</code>:
    <span><WindowBarSwatch part="used" /> used</span>
    <span><WindowBarSwatch part="more" /> added by the reset at this burn</span>
    <span><WindowBarSwatch part="unused" /> left unused</span>
    <span><WindowBarSwatch part="elapsed" /> time gone</span>
  </p>;
}
