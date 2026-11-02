import { useEffect } from 'react';
import { buildProviderCards, type ProviderCard } from '../../../core/fabric/provider-cards.js';
import type { PoolResourceView, ResourceView } from '../../../core/fabric/resource-view.js';
import { apiGet } from '../../data/client.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import type { QueryDef } from '../../data/queries.js';
import { BurnDown } from '../../components/charts/BurnDown.js';
import { Meter } from '../../components/primitives/Meter.js';
import { ProviderMark } from './ProviderMark.js';
import styles from './ProviderCards.module.css';

export const resourceViewQuery: QueryDef<ResourceView> = {
  key: 'resource-view', fetch: signal => apiGet<ResourceView>('/api/resource', signal),
};

const date = (value: string | null) => value === null ? 'unknown' : new Date(value).toLocaleString();
const HOUR = 3_600_000;

/**
 * Burn-down points come only from the reading itself: the current remaining
 * share, and one earlier point implied by the observed burn rate. No reading,
 * burn or reset means no chart, and the card says so.
 */
export function burnDownInput(pool: PoolResourceView, generatedAt: string) {
  if (pool.pctUsed === null || pool.burnRatePerHour === null || pool.resetAt === null || pool.fetchedAt === null) return null;
  const reading = Date.parse(pool.fetchedAt), reset = Date.parse(pool.resetAt), now = Date.parse(generatedAt);
  if (![reading, reset, now].every(Number.isFinite) || reset <= now) return null;
  const earlier = reading - HOUR;
  return { reset, now, start: earlier, points: [
    { t: earlier, remaining: Math.min(100, 100 - pool.pctUsed + pool.burnRatePerHour) },
    { t: reading, remaining: 100 - pool.pctUsed },
  ] };
}

function PoolRow({ pool, generatedAt }: { pool: PoolResourceView; generatedAt: string }) {
  const chart = burnDownInput(pool, generatedAt);
  return <li className={styles.pool}>
    <Meter variant="labelled" label={<span>{pool.pool} <span data-status={pool.status}>{pool.status}</span></span>}
      value={pool.pctUsed} max={pool.pctUsed === null ? null : 100}
      valueText={pool.pctUsed === null ? 'unknown' : `${pool.pctUsed.toFixed(1)}% used`} />
    <p className={styles.caption}>Resets {date(pool.resetAt)}. Burn {pool.burnRatePerHour === null ? 'unknown' : `${pool.burnRatePerHour.toFixed(2)} pp/hour`}.</p>
    {chart ? <BurnDown title={`${pool.pool} burn-down`} points={chart.points} capacity={100} start={chart.start}
      resetAt={chart.reset} now={chart.now} height={150} formatValue={v => `${v.toFixed(0)}% left`}
      caveat="Forecast uses the observed burn rate. The window start is not reported."
      ariaLabel={`${pool.pool} remaining capacity burning down to its reset`} />
      : <p className={styles.caption}>No burn-down: this pool lacks a fresh reading, burn rate or upcoming reset.</p>}
  </li>;
}

export function ProviderCardView({ card, generatedAt }: { card: ProviderCard; generatedAt: string }) {
  return <article className={styles.card} aria-label={`${card.label} capacity`}>
    <header className={styles.cardHeader}>
      <ProviderMark provider={card.provider} label={card.label} />
      <h3>{card.label}</h3>
      <span className={styles.badge} data-status={card.status}>{card.status}</span>
    </header>
    <p className={styles.caption}>Highest used {card.maxPctUsed === null ? 'unknown' : `${card.maxPctUsed.toFixed(1)}%`}. Next reset {date(card.nextResetAt)}.</p>
    <ul className={styles.pools}>{card.pools.map(pool => <PoolRow key={pool.pool} pool={pool} generatedAt={generatedAt} />)}</ul>
  </article>;
}

/** One card per provider, grouped into capacity pools. Mirrors `phm resource --cards --json`. */
export function ProviderCards({ view }: { view: ResourceView }) {
  const cards = buildProviderCards(view);
  return <div className={styles.grid} aria-label="Provider capacity pools">
    {cards.providers.map(card => <ProviderCardView key={card.provider} card={card} generatedAt={cards.generatedAt} />)}
    <article className={styles.card} aria-label="Local models capacity">
      <header className={styles.cardHeader}><ProviderMark provider="local" label="Local" /><h3>Local</h3></header>
      <p className={styles.caption}>Local models: {cards.localModels.count ?? 'unknown'}. No provider quota applies.</p>
    </article>
  </div>;
}

export function useResourceView(intervalMs = 15_000) {
  const query = useQuery(resourceViewQuery);
  const refetch = useRefetch(resourceViewQuery);
  useEffect(() => {
    const timer = window.setInterval(refetch, intervalMs);
    return () => window.clearInterval(timer);
  }, [refetch, intervalMs]);
  return query;
}
