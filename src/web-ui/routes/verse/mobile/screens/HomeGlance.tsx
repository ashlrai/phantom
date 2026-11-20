/**
 * The phone opens here, on exactly seven things, top to bottom:
 *  -1. the four tiles: merged, time to merge, main green, plan runway (`phm status --brief --json`);
 *   0. the Pulse card: five numbers with a trend each (the desktop Home card, `phm fleet pulse`);
 *   1. one line of fleet health: merges in the last hour, lanes running, main
 *      green or red (one read of `phm home --json`, home.v1);
 *   2. decisions, one tap each (the desktop Home Decisions card, built on `phm approvals`);
 *   3. the leader's newest reply (the desktop Home From your leader card, `phm leader replies`);
 *   3b. the Supply card: is the fleet feeding itself (`phm doctor supply --json`);
 *   4. a box that posts to the fleet inbox, the same API as the desktop inbox box;
 *   5. what shipped today (the desktop Shipped card, `phm shipped --since 1d`).
 * A fact the Mac could not read says unknown, never 0.
 */
import type { HomeField, HomeSummary } from '../../../../../core/fleet/home.js';
import { refetchQuery } from '../../../../data/cache.js';
import { apiGet, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import type { QueryDef } from '../../../../data/queries.js';
import { BriefTiles, briefQuery } from '../BriefTiles.js';
import { ApprovalsCard, approvalAsksQuery } from '../../home/ApprovalsCard.js';
import { LeaderRepliesCard, leaderRepliesQuery } from '../../home/LeaderRepliesCard.js';
import { MachinesCard } from '../../home/MachinesCard.js';
import { PoolsCard, poolsQuery } from '../../home/PoolsCard.js';
import { PulseCard, pulseQuery } from '../../home/PulseCard.js';
import { PulseStrip, pulseLanesQuery } from '../../home/PulseStrip.js';
import { SupplyCardPhone, supplyQuery } from '../../home/SupplyCard.js';
import { ShippedCard, shippedQuery } from '../../home/ShippedCard.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { MobileInterject } from '../MobileInterject.js';
import { Button, SkeletonList } from '../ui.js';
import { ui } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

export const HOME_PATH = '/api/verse/fleet/runs/home';
/** Approvals drawn at once; the rest surface as these are answered, so the numbers stay on the first screen. */
export const APPROVALS_SHOWN = 2;
/** Null when the Mac answered with something that is not this home.v1 (an older build, before needsYou). */
export const homeQuery: QueryDef<HomeSummary | null> = {
  key: 'mobile-home',
  async fetch(signal) {
    const value = await apiGet<Partial<HomeSummary> | null>(HOME_PATH, signal);
    return value?.schema === 'home.v1' && !!value.running && !!value.main && !!value.mergedLastHour && !!value.merged24h && !!value.needsYou ? value as HomeSummary : null;
  },
};
export const refreshHomeGlance = (): Promise<unknown> => Promise.all([
  refetchQuery(briefQuery.key, () => briefQuery.fetch(), true).catch(() => undefined),
  refetchQuery(poolsQuery.key, () => poolsQuery.fetch(), true).catch(() => undefined),
  refetchQuery(homeQuery.key, () => homeQuery.fetch(), true).catch(() => undefined),
  refetchQuery(approvalAsksQuery.key, () => approvalAsksQuery.fetch(), true).catch(() => undefined),
  refetchQuery(pulseLanesQuery.key, () => pulseLanesQuery.fetch(), true).catch(() => undefined),
  refetchQuery(pulseQuery.key, () => pulseQuery.fetch(), true).catch(() => undefined),
  refetchQuery(leaderRepliesQuery(1).key, () => leaderRepliesQuery(1).fetch(), true).catch(() => undefined),
  refetchQuery(supplyQuery.key, () => supplyQuery.fetch(), true).catch(() => undefined),
  refetchQuery(shippedQuery(1).key, () => shippedQuery(1).fetch(), true).catch(() => undefined),
]);

const known = <T,>(field: HomeField<T>, say: (value: T) => string, unknown: string): string => field.state === 'ok' ? say(field.value) : unknown;

/** "7 merged in the last hour · 2 lanes running · main green". Red names the repos; anything unread says unknown. */
export function healthLine(home: HomeSummary): { text: string; tone: 'ok' | 'red' | 'unknown' } {
  const red = home.main.state === 'ok' ? home.main.value.filter((repo) => repo.state === 'red').map((repo) => repo.repo) : [];
  const green = home.main.state === 'ok' && home.main.value.length > 0 && home.main.value.every((repo) => repo.state === 'green');
  const text = [
    known(home.mergedLastHour, (count) => `${count} merged in the last hour`, 'merges unknown'),
    known(home.running, (lanes) => { const busy = lanes.filter((lane) => lane.running > 0).length; return `${busy} ${busy === 1 ? 'lane' : 'lanes'} running`; }, 'lanes unknown'),
    red.length ? `main red: ${red.join(', ')}` : green ? 'main green' : 'main unknown',
  ].join(' · ');
  return { text, tone: red.length ? 'red' : green && home.mergedLastHour.state === 'ok' && home.running.state === 'ok' ? 'ok' : 'unknown' };
}

export function HomeGlance() {
  const { permissions, navigate } = useMobile();
  const read = useQuery(homeQuery);
  const refetch = useRefetch(homeQuery);
  usePollWhileVisible(refetch, 15_000);
  const home = read.data ?? null;
  const loading = !home && (read.status === 'loading' || read.status === 'idle');
  if (loading) return <SkeletonList rows={4} label="Loading Home" />;
  const health = home ? healthLine(home) : null;
  return (
    <>
      <BriefTiles />
      <PulseStrip />
      <PulseCard />
      {health ? <p className={styles.health} data-tone={health.tone} role="status" aria-label="Fleet health">{health.text}</p> : (
        <section className={`${ui.card} ${styles.needs}`} role="alert">
          <p className={styles.askText}>Fleet health is unknown. {read.error ? readFailureReason(read.error) : 'Your Mac’s build does not serve it yet. Update Phantom on your Mac.'}</p>
          <Button variant="tinted" onClick={() => refetch()}>Try again</Button>
        </section>
      )}
      {/* Approvals stand on their own API: what only Mason can decide does not wait on the health line. */}
      <ApprovalsCard from="phone" canAnswer={canShowActions(permissions)} limit={APPROVALS_SHOWN} />
      <LeaderRepliesCard limit={1} />
      <SupplyCardPhone />
      <PoolsCard onOpenJob={job => navigate({ screen: 'worker', job })} />
      <MachinesCard className={ui.card} />
      <MobileInterject compact title="Message the leader" placeholder="Say it in plain words." />
      <ShippedCard days={1} />
    </>
  );
}
