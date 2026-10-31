import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible, useSectionVisible, useDocumentVisible } from '../shell/section-visibility.js';
import { busFeedMissing, busFeedQuery } from './bus-feed-queries.js';
import { busTimeline, eventTone, relativeAt } from './bus-feed-model.js';
import styles from './bus-feed.module.css';

export function BusFeed({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(busFeedQuery, { enabled: sectionVisible && documentVisible });
  const refetch = useRefetch(busFeedQuery);
  usePollWhileVisible(() => { if (!busFeedMissing()) refetch(); }, 10_000, { enabled: !busFeedMissing() });
  if (busFeedMissing()) return <p>Agent bus is not in this build yet.</p>;
  if (query.status === 'loading' || query.status === 'idle') return <SkeletonLine />;
  if (!query.data) return <p>Agent bus is unavailable.</p>;
  const data = query.data;
  const rows = busTimeline(data);
  return <div className={styles.feed}>
    {query.error && query.updatedAt !== null ? <p role="status">Agent bus could not refresh · showing the reading from {new Date(query.updatedAt).toLocaleTimeString('en-GB')}</p> : null}
    <div className={styles.header}>
      <span>Agent bus · {data.hops.length ? `${data.hops.length} hops · last hop ${relativeAt(data.lastHopAt, now)}` : 'no hops yet'}</span>
      {query.status === 'refreshing' ? <RefreshIndicator /> : null}
      {(['hops', 'events'] as const).map(source => data.sources[source] !== 'healthy'
        ? <StatusBadge key={source} status={data.sources[source]} tone="warning">{source === 'hops' ? 'hop log' : 'events'} {data.sources[source]}</StatusBadge> : null)}
    </div>
    {data.hopsDropped > 0 ? <p>{data.hopsDropped} older hops omitted.</p> : null}
    {rows.length === 0 ? <EmptyState compact title="The bus is quiet. Hops appear when agents message each other." /> : null}
    <ul aria-label="Agent bus" className={styles.list}>
      {rows.map(row => <li key={row.key} className={styles.row} data-tone={row.kind === 'hop' ? 'neutral' : eventTone(row.kind)}>
        {row.kind !== 'hop' ? <><time dateTime={row.at ?? undefined} title={row.at ?? undefined}>{relativeAt(row.at, now)}</time><Tag size="sm" className={styles.kind}>{row.kind}</Tag></> : null}
        <span className={`${styles.text} ${row.kind === 'hop' ? styles.hop : ''}`} title={row.text}>{row.text}</span>
      </li>)}
    </ul>
  </div>;
}
