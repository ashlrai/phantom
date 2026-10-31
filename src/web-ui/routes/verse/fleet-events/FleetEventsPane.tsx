import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatDuration, formatRelative } from '../autonomy/format.js';
import { safeHref } from '../cloud/cloud-model.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { diffNew, filterByKinds, readFeed, sortNewestFirst, summarizeKinds, type FeedItem } from './fleet-events-model.js';
import { fleetEventsQuery } from './fleet-events-queries.js';
import styles from './fleet-events.module.css';

export function FleetEventsPane({ visible, host }: PaneProps) {
  const read = useQuery(fleetEventsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetEventsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible });
  const feed = useMemo(() => readFeed(read.data), [read.data]);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<FeedItem[]>([]);
  const [arrivals, setArrivals] = useState<FeedItem[]>([]);
  const [merged, setMerged] = useState<FeedItem[] | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => {
    if (!paused || read.data == null) return;
    setArrivals(current => [...current, ...diffNew(new Set([...frozen, ...current].map(item => item.id)), feed.items)]);
  }, [feed, frozen, paused, read.data]);
  useEffect(() => { setMerged(null); }, [read.data]);
  const items = paused ? frozen : merged ?? feed.items;
  const kinds = [...new Set([...items.map(item => item.kind), 'publish'])].sort();
  const rows = filterByKinds(items, new Set(kind ? [kind] : []));
  const missing = read.data === null || (read.error instanceof ApiError && read.error.status === 404);
  const togglePause = () => {
    if (!paused) { setFrozen(items); setArrivals([]); setPaused(true); }
    else {
      const added = diffNew(new Set([...frozen, ...arrivals].map(item => item.id)), feed.items);
      setMerged(sortNewestFirst([...frozen, ...arrivals, ...added]));
      setPaused(false);
    }
  };
  if (missing) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const leaders = feed.leaders.length ? feed.leaders.map(l => `${l.label} ${l.ageSeconds === null ? '—' : formatDuration(l.ageSeconds * 1000)}`).join(', ') : '—';
  return <section className={styles.root} aria-label="Fleet events">
    <p className={styles.header}>Leaders: {leaders} · {feed.agents ?? '—'} agents · {feed.pending ?? '—'} job files pending</p>
    {feed.sourceState !== 'healthy' && <p className={styles.notice} role="status">Dispatcher events may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    <p className={styles.summary}>{summarizeKinds(items)}</p>
    <div className={styles.controls}>
      <div className={styles.filters} aria-label="Filter event kinds">{kinds.map(value => <Button key={value} size="sm" variant="subtle" aria-pressed={kind === value} onClick={() => setKind(kind === value ? null : value)}>{value}</Button>)}</div>
      <Button size="sm" aria-pressed={paused} onClick={togglePause}>{paused ? `Resume${arrivals.length ? ` · ${arrivals.length} new` : ''}` : 'Pause'}</Button>
    </div>
    {rows.length === 0 ? <p className={styles.message}>{items.length ? 'No events match this filter.' : 'No fleet events yet.'}</p> :
      <ol className={styles.list} aria-label="Fleet event feed">{rows.map(item => {
        const href = item.kind === 'publish' && item.url && /^https:\/\/github\.com\/[^\s?#]+$/.test(item.url) ? safeHref(item.url, 'github.com') : null;
        const valid = Number.isFinite(Date.parse(item.at));
        return <li key={item.id} className={styles.row}>
          <time className={styles.time} dateTime={valid ? item.at : undefined} title={valid ? new Date(item.at).toLocaleString() : undefined}>{formatRelative(item.at)}</time>
          <Tag size="sm">{item.kind}</Tag>
          <span className={styles.text}><JobRefs text={item.text} onOpenJob={job => { requestWorkerLogJob(job); host.openPane('worker-log'); }} />{href && <> · <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Pull request for ${item.text}`}>PR <IconExternalLink size={12} aria-hidden="true" /></a></>}</span>
        </li>;
      })}</ol>}
  </section>;
}
