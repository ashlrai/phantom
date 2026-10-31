import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { busFeedMissing, busFeedQuery, type BusEvent, type BusKind } from '../fleet/bus-feed-queries.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { busFilterLabel, groupEvents, isInterjection, matchEvents, summarizeHops } from './fleet-bus-model.js';
import styles from './fleet-bus.module.css';

// Include an occurrence number so identical log lines remain separate events.
function identify(events: readonly BusEvent[]) {
  const counts = new Map<string, number>();
  return events.map(event => {
    const identity = JSON.stringify([event.at, event.kind, event.text]);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    return { event, id: `${identity}:${occurrence}` };
  });
}
type IdentifiedEvent = ReturnType<typeof identify>[number];
const newEvents = (known: readonly IdentifiedEvent[], current: readonly IdentifiedEvent[]) => {
  const ids = new Set(known.map(item => item.id));
  return current.filter(item => !ids.has(item.id));
};
const count = (value: number | null) => value === null ? '—' : value.toLocaleString();

export function FleetBusPane({ visible, host }: PaneProps) {
  const read = useQuery(busFeedQuery, { enabled: visible && !busFeedMissing(), freshMs: 0 });
  const refetch = useRefetch(busFeedQuery);
  usePollWhileVisible(() => { if (!busFeedMissing()) refetch(); }, 5_000, { enabled: visible && !busFeedMissing() });
  const events = useMemo(() => identify(read.data?.events ?? []), [read.data]);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<IdentifiedEvent[]>([]);
  const [arrivals, setArrivals] = useState<IdentifiedEvent[]>([]);
  const [merged, setMerged] = useState<IdentifiedEvent[] | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<BusKind | null>(null);
  useEffect(() => {
    if (paused && read.data) setArrivals(current => [...current, ...newEvents([...frozen, ...current], events)]);
  }, [events, frozen, paused, read.data]);
  useEffect(() => { setMerged(null); }, [read.data]);
  const items = paused ? frozen : merged ?? events;
  const kinds = [...new Set(items.map(item => item.event.kind))].sort();
  const ordered = matchEvents(groupEvents(items.map(item => item.event), kind), query);
  const filterLabel = busFilterLabel(ordered.length, items.length);
  const togglePause = () => {
    if (!paused) { setFrozen(items); setArrivals([]); setPaused(true); }
    else {
      setMerged([...frozen, ...arrivals, ...newEvents([...frozen, ...arrivals], events)]);
      setPaused(false);
    }
  };
  if (busFeedMissing() || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Bus not in this build</p>;
  if (read.data === undefined || read.data === null) return <div className={styles.root} role="status">{read.status === 'error' || read.data === null ? 'Bus is unavailable.' : <><span>Reading bus…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const data = read.data;
  const totals = summarizeHops(data.hops);
  return <section className={styles.root} aria-label="Bus">
    <p className={styles.header}>{totals.hops.toLocaleString()} hops · in {count(totals.inputTokens)} / out {count(totals.outputTokens)} tokens · {totals.agents.toLocaleString()} agents{data.hopsDropped > 0 && <> · hops dropped {data.hopsDropped.toLocaleString()}</>}</p>
    {(data.sources.hops !== 'healthy' || data.sources.events !== 'healthy') && <p className={styles.notice} role="status">Bus data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Bus could not refresh. Showing the last reading.</p>}
    <div className={styles.controls}>
      <div className={styles.filters} aria-label="Filter event kinds">{kinds.map(value => <Button key={value} size="sm" variant="subtle" aria-pressed={kind === value} onClick={() => setKind(kind === value ? null : value)}>{value}</Button>)}</div>
      <input className={styles.search} type="search" aria-label="Filter bus events" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
      <Button size="sm" aria-pressed={paused} onClick={togglePause}>{paused ? `Resume${arrivals.length ? ` · ${arrivals.length} new` : ''}` : 'Pause'}</Button>
    </div>
    {filterLabel && <p className={styles.message}>{filterLabel}</p>}
    {ordered.length === 0 ? <p className={styles.message}>{items.length ? 'No events match this filter.' : 'No bus events yet.'}</p> :
      <ol className={styles.list} aria-label="Bus event feed">{identify(ordered).map(({ event, id }) => <li key={id} className={`${styles.row} ${isInterjection(event) ? styles.interjection : ''}`} aria-label={isInterjection(event) ? 'Interjection' : undefined}>
        <time className={styles.time} dateTime={event.at} title={new Date(event.at).toLocaleString()}>{formatRelative(event.at)}</time>
        <Tag size="sm">{event.kind}</Tag><span className={styles.text}><JobRefs text={event.text} onOpenJob={job => { requestWorkerLogJob(job); host.openPane('worker-log'); }} /></span>
      </li>)}</ol>}
  </section>;
}
