import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { usePollWhileVisible, useSectionVisible, useDocumentVisible } from '../shell/section-visibility.js';
import { JobRefs } from './JobRefs.js';
import { busFeedMissing, busFeedQuery } from './bus-feed-queries.js';
import { busTimeline, eventTone, relativeAt } from './bus-feed-model.js';
import { WORK_TRACE_MAX_IDS, parseWorkTrace, requestMessageId, unknownWorkChip, workStateChip, workTraceUrl, type WorkTrace } from './work-trace-model.js';
import styles from './bus-feed.module.css';

// One batched, read-only call for the request rows on screen; keyed by the id set.
const idleTrace: QueryDef<WorkTrace | null> = { key: 'verse-fleet-work-trace:none', fetch: async () => null };
const workTraceQuery = (ids: readonly string[]): QueryDef<WorkTrace | null> => ids.length === 0 ? idleTrace : {
  key: `verse-fleet-work-trace:${ids.join('\n')}`,
  fetch: async signal => parseWorkTrace(await apiGet<unknown>(workTraceUrl(ids), signal)),
};

export function BusFeed({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(busFeedQuery, { enabled: sectionVisible && documentVisible });
  const refetch = useRefetch(busFeedQuery);
  const rows = query.data ? busTimeline(query.data) : [];
  const requestIds = [...new Set(rows.flatMap(row => row.kind === 'inbox' ? requestMessageId(row.text) ?? [] : []))].slice(0, WORK_TRACE_MAX_IDS);
  const trace = workTraceQuery(requestIds);
  const traceQuery = useQuery(trace, { enabled: sectionVisible && documentVisible && requestIds.length > 0 });
  const refetchTrace = useRefetch(trace);
  usePollWhileVisible(() => { if (!busFeedMissing()) { refetch(); if (requestIds.length > 0) refetchTrace(); } }, 10_000, { enabled: !busFeedMissing() });
  if (busFeedMissing()) return <p>Agent bus is not in this build yet.</p>;
  if (query.status === 'loading' || query.status === 'idle') return <SkeletonLine />;
  if (!query.data) return <p>Agent bus is unavailable.</p>;
  const data = query.data;
  const traced = new Map((traceQuery.data?.items ?? []).map(item => [item.id, item]));
  const traceFailed = traceQuery.data == null;
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
        {row.kind === 'inbox' ? <WorkChip id={requestMessageId(row.text)} item={traced.get(requestMessageId(row.text) ?? '')} failed={traceFailed} /> : null}
        <span className={`${styles.text} ${row.kind === 'hop' ? styles.hop : ''}`} title={row.text}><JobRefs text={row.text} onOpenJob={job => { requestWorkerLogJob(job); openDockPane('worker-log'); }} /></span>
      </li>)}
    </ul>
  </div>;
}

/** Never silently absent: loading, failure and an unreadable id all read "state unknown". */
function WorkChip({ id, item, failed }: { id: string | null; item: Parameters<typeof workStateChip>[0]; failed: boolean }) {
  const chip = id === null ? unknownWorkChip('This row does not name a message id.')
    : failed ? unknownWorkChip('Work state could not be read yet.') : workStateChip(item);
  return <span data-work-state={chip.label} data-work-tone={chip.tone} className={styles.kind}><Tag size="sm" title={chip.title}>{chip.label}</Tag></span>;
}
