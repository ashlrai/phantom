import { useId } from 'react';
import type { CompactLeaderBrief } from '../../../../core/fleet/leader-compact-brief.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './FleetNowCard.module.css';

export const fleetNowQuery: QueryDef<CompactLeaderBrief | { state: 'no data' }> = {
  key: 'verse-fleet-now',
  fetch: signal => apiGet('/api/verse/fleet/runs/leader-brief', signal),
};
export function poolWords(pool: CompactLeaderBrief['pools'][number]): string {
  if (pool.verdict === 'over') return 'spending too fast';
  if (pool.verdict === 'ok') return pool.burnPerHour === 0 ? 'unused' : 'on pace';
  return 'pace unknown';
}
export function FleetNowCard() {
  const id = useId(), read = useQuery(fleetNowQuery), refresh = useRefetch(fleetNowQuery);
  usePollWhileVisible(refresh, 60_000);
  const brief = read.data && 'pools' in read.data && read.data.state === 'ready' ? read.data : null;
  const pools = brief?.pools.slice(0, 3) ?? [];
  const main = brief?.main ?? [];
  const mainWord = main.some(m => m.state === 'red' && !m.stale) ? 'red'
    : main.length && main.every(m => m.state === 'green' && !m.stale) ? 'green' : 'unknown';
  const merges = brief && brief.sources.ledger === 'healthy' && !brief.omitted
    ? brief.families.reduce((sum, family) => sum + family.merges, 0) : 'unknown';
  const busy = brief?.lanes.filter(l => (l.running ?? 0) > 0).length ?? 0;
  const lanes = brief?.lanes.length && brief.lanes.every(l => l.running !== null)
    ? `${busy} ${brief.omitted ? 'observed ' : ''}lane${busy === 1 ? '' : 's'} busy` : 'busy lanes unknown';
  return <section className={styles.card} aria-labelledby={id}>
    <h2 id={id}>Fleet now</h2>
    {brief ? <time dateTime={brief.at}>Updated {new Date(brief.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}
    {brief ? <ul aria-label="Fleet summary">
      <li>{merges} PRs merged in {brief.windowHours} h, {lanes}, main {mainWord}</li>
      {pools.map((pool, index) => <li key={pool.pool}>{pool.pool}: {poolWords(pool)}
        {index === pools.length - 1 && brief.pools.length > pools.length ? ` · ${brief.pools.length - pools.length} more pools` : ''}</li>)}
      <li>Worst job family: {brief.families[0] ? `${brief.families[0].family} · ${brief.families[0].prs} PRs from ${brief.families[0].launches} starts` : 'unknown'}</li>
      <li>Stuck or quiet: {brief.attention.map(job => `${job.id} (${job.status})`).join(', ') || (brief.sources['queue/live-jobs.json'] === 'healthy' ? 'none' : 'unknown')}
        {read.status === 'error' ? ' · Could not refresh; showing the last reading.' : ''}</li>
    </ul> : <p>No fleet data yet</p>}
  </section>;
}
