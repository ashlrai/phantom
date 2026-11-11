/**
 * components/fleet/FleetHealthStrip.tsx — the glanceable per-lane health
 * strip: live jobs against the lane's slot target, ready-queue depth, and
 * the observed credit reading (or an honest "credit unknown"), plus a HELD
 * marker when the lane is held.
 *
 * The full engineering console stays on /control/fleet (LanesPanel,
 * LiveFleetBoard) — this is the compact read of the same snapshot
 * (GET /api/fleet/lanes), meant to sit at the top of Show mode and the
 * Fleet Dashboard. It self-polls every 15s while visible, matching Show
 * mode's refresh cadence, so it stays warm wherever it's mounted.
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { fleetLanesQuery } from '../../data/queries.js';
import { ProviderLogo, providerEngine } from '../primitives/ProviderLogo.js';
import { SkeletonLine } from '../primitives/Skeleton.js';
import { readFailureReason } from '../../data/client.js';
import { buildLaneHealth, liveOverTarget, type LaneHealth } from './fleet-health.js';
import styles from './FleetHealthStrip.module.css';

const POLL_MS = 15_000;

function LaneChip({ lane }: { lane: LaneHealth }) {
  const mark = providerEngine(lane.lane);
  const title = [
    `${lane.lane}: ${liveOverTarget(lane)} live`,
    `queue ${lane.queue === null ? 'unknown' : lane.queue}`,
    lane.creditLabel ? `credit ${lane.creditLabel}` : 'credit unknown',
    lane.held && lane.holdReason ? `held — ${lane.holdReason}` : lane.held ? 'held' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={styles.chip} data-held={lane.held || undefined} title={title}>
      <span className={styles.lane}>
        {mark ? <ProviderLogo engine={mark} size={14} /> : null}
        {lane.lane}
        {lane.held ? <em className={styles.held}>HELD</em> : null}
      </span>
      <span className={styles.live}>
        {liveOverTarget(lane)} <small>live</small>
      </span>
      <span className={styles.sub}>
        queue {lane.queue === null ? '—' : lane.queue} · {lane.creditLabel ?? 'credit unknown'}
      </span>
      {lane.creditPct !== null ? (
        <span
          className={styles.track}
          role="meter"
          aria-label={`${lane.lane} credit remaining`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(lane.creditPct)}
        >
          <span className={styles.fill} data-low={lane.creditPct < 20} style={{ width: `${lane.creditPct}%` }} />
        </span>
      ) : null}
    </li>
  );
}

export function FleetHealthStrip() {
  const query = useQuery(fleetLanesQuery);
  const refetch = useRefetch(fleetLanesQuery);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') refetch();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  const snapshot = query.data;
  const lanes = useMemo(() => buildLaneHealth(snapshot), [snapshot]);

  return (
    <section className={styles.strip} aria-label="Lane health">
      <div className={styles.stripHead}>
        <span className={styles.stripTitle}>Lanes</span>
        <span className={styles.stripMeta}>
          {snapshot
            ? `${lanes.length} observed · snapshot ${snapshot.generatedAt}${query.status === 'refreshing' ? ' · refreshing' : ''}`
            : query.status === 'loading'
              ? 'reading…'
              : 'unavailable'}
        </span>
      </div>
      {query.status === 'loading' && !snapshot ? (
        <SkeletonLine width="90%" />
      ) : query.status === 'error' && !snapshot ? (
        <p className={styles.error} role="alert">
          {readFailureReason(query.error)}
        </p>
      ) : lanes.length === 0 ? (
        <p className={styles.empty}>No lanes observed — every lane source is missing or empty.</p>
      ) : (
        <ul className={styles.chips}>
          {lanes.map((lane) => (
            <LaneChip key={lane.lane} lane={lane} />
          ))}
        </ul>
      )}
    </section>
  );
}
