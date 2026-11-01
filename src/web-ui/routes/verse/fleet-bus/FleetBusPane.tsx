import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { busFeedMissing, busFeedQuery } from '../fleet/bus-feed-queries.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { busFilterLabel, busRows, groupEvents, isInterjection, matchEvents, summarizeHops, type BusRow } from './fleet-bus-model.js';
import { agentBusMissing, agentBusPageQuery, agentBusStatusQuery, type AgentBusReceipt } from './agent-bus-queries.js';
import { busStatusLine, envelopeRows, isMasonInterjection } from './agent-bus-model.js';
import { BusPostBox, type BusPostPrefill } from './BusPostBox.js';
import { recentSenders } from './bus-post-model.js';
import styles from './fleet-bus.module.css';

// Include an occurrence number so identical log lines remain separate events.
function identify(events: readonly BusRow[]) {
  const counts = new Map<string, number>();
  return events.map(event => {
    const identity = JSON.stringify(event.kind === 'hop' ? [event.kind, event.hopId] : [event.at, event.kind, event.text]);
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

export function FleetBusPane(props: PaneProps) {
  const [view, setView] = useState<'dispatch' | 'durable'>('dispatch');
  const [query, setQuery] = useState('');
  return <section aria-label="Bus views">
    <div className={styles.viewToggle} aria-label="Bus view">
      <Button size="sm" aria-pressed={view === 'dispatch'} onClick={() => setView('dispatch')}>Dispatch feed</Button>
      <Button size="sm" aria-pressed={view === 'durable'} onClick={() => setView('durable')}>Durable bus</Button>
    </div>
    <div hidden={view !== 'dispatch'}><DispatchFeed {...props} visible={props.visible && view === 'dispatch'} query={query} setQuery={setQuery} /></div>
    <div hidden={view !== 'durable'}><DurableBus visible={props.visible && view === 'durable'} query={query} setQuery={setQuery} /></div>
  </section>;
}

function DispatchFeed({ visible, host, query, setQuery }: PaneProps & { query: string; setQuery: (value: string) => void }) {
  const read = useQuery(busFeedQuery, { enabled: visible && !busFeedMissing(), freshMs: 5_000 });
  const refetch = useRefetch(busFeedQuery);
  usePollWhileVisible(() => { if (!busFeedMissing()) refetch(); }, 5_000, { enabled: visible && !busFeedMissing() });
  const events = useMemo(() => identify(busRows(read.data?.events ?? [], read.data?.hops ?? [], 60, read.data?.lastHopAt)), [read.data]);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<IdentifiedEvent[]>([]);
  const [arrivals, setArrivals] = useState<IdentifiedEvent[]>([]);
  const [merged, setMerged] = useState<IdentifiedEvent[] | null>(null);
  const [kind, setKind] = useState<BusRow['kind'] | null>(null);
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
      <div className={styles.filters} aria-label="Filter event kinds">{kinds.map(value => <Button key={value} size="sm" variant="subtle" aria-pressed={kind === value} onClick={() => setKind(kind === value ? null : value)}>{value === 'hop' ? 'Hops' : value}</Button>)}</div>
      <input className={styles.search} type="search" aria-label="Filter bus events" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
      <Button size="sm" aria-pressed={paused} onClick={togglePause}>{paused ? `Resume${arrivals.length ? ` · ${arrivals.length} new` : ''}` : 'Pause'}</Button>
    </div>
    {filterLabel && <p className={styles.message}>{filterLabel}</p>}
    {ordered.length === 0 ? <p className={styles.message}>{items.length ? 'No events match this filter.' : 'No bus events yet.'}</p> :
      <ol className={styles.list} aria-label="Bus event feed">{identify(ordered).map(({ event, id }) => <li key={id} className={`${styles.row} ${isInterjection(event) ? styles.interjection : ''}`} aria-label={isInterjection(event) ? 'Interjection' : undefined}>
        {event.kind === 'hop' ? <span className={styles.time} /> : <time className={styles.time} dateTime={event.at} title={new Date(event.at).toLocaleString()}>{formatRelative(event.at)}</time>}
        <Tag size="sm">{event.kind}</Tag><span className={styles.text}>{event.kind === 'hop' ? event.text : <JobRefs text={event.text} onOpenJob={job => { requestWorkerLogJob(job); host.openPane('worker-log'); }} />}</span>
      </li>)}</ol>}
  </section>;
}


const PAGE_LIMIT = 50;
const channelLabels = { telegram: 'Telegram', email: 'email', mobile: 'phone', desktop: 'desktop', page: 'page', cli: 'CLI' } as const;
function durableError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Read session expired. Reopen the console.';
    if (error.status === 404) return 'This hub has no durable bus route yet (update the hub).';
    if (error.status === 503) return 'Durable bus storage unavailable.';
  }
  return 'Durable bus is unavailable.';
}
function DurableBus({ visible, query, setQuery }: { visible: boolean; query: string; setQuery: (value: string) => void }) {
  const status = useQuery(agentBusStatusQuery, { enabled: visible && !agentBusMissing(), freshMs: 10_000 });
  const after = Math.max(0, (status.data?.retainedCount ?? 0) - PAGE_LIMIT);
  const pageQuery = useMemo(() => agentBusPageQuery(after), [after]);
  const page = useQuery(pageQuery, { enabled: visible && !!status.data && !agentBusMissing(), freshMs: 10_000 });
  const refreshStatus = useRefetch(agentBusStatusQuery);
  const refreshPage = useRefetch(pageQuery);
  const refreshPostedStatus = useRefresh(agentBusStatusQuery);
  const refreshPostedPage = useRefresh(pageQuery);
  const [prefill, setPrefill] = useState<BusPostPrefill | null>(null);
  usePollWhileVisible(() => { if (!agentBusMissing()) { refreshStatus(); if (status.data) refreshPage(); } }, 10_000,
    { enabled: visible && !agentBusMissing() });
  const [messages, setMessages] = useState<AgentBusReceipt[]>([]);
  const [olderBoundary, setOlderBoundary] = useState<number | null>(null);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    if (!page.data) return;
    setMessages(current => [...new Map([...current, ...page.data!.messages].map(row => [row.cursor, row])).values()]);
    setOlderBoundary(current => current === null ? after : Math.min(current, after));
  }, [page.data, after]);
  const loadOlder = async () => {
    const oldest = messages.length ? Math.min(...messages.map(row => row.cursor)) : olderBoundary ?? 0;
    const boundary = Math.min(oldest, olderBoundary ?? oldest);
    const previous = Math.max(0, boundary - PAGE_LIMIT);
    setLoadingOlder(true); setOlderError(null);
    try {
      const result = await agentBusPageQuery(previous).fetch();
      if (!result) throw new Error('Invalid bus page');
      setMessages(current => [...new Map([...result.messages, ...current].map(row => [row.cursor, row])).values()]);
      setOlderBoundary(previous);
    } catch (error) { setOlderError(error); }
    finally { setLoadingOlder(false); }
  };
  const error = status.error ?? page.error ?? olderError;
  const errorText = agentBusMissing() ? 'This hub has no durable bus route yet (update the hub).' : error ? durableError(error) : null;
  const allRows = envelopeRows(messages, Date.now());
  const rows = allRows.filter(row =>
    [row.from, row.to, row.priority, row.kind, row.channel ?? '', row.excerpt].some(value => value.toLowerCase().includes(query.toLowerCase())));
  return <section className={styles.root} aria-label="Durable bus">
    {status.data && <p className={styles.header}>{busStatusLine(status.data)}</p>}
    {errorText && <p className={styles.notice} role="status">{errorText}</p>}
    {!errorText && (status.data === null || page.data === null) && <p className={styles.notice}>Durable bus is unavailable.</p>}
    <input className={styles.search} type="search" aria-label="Filter bus events" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
    {rows.length > 0 ? <ol className={styles.list} aria-label="Durable bus envelopes">{rows.map(row =>
      <li key={row.cursor} className={`${styles.row} ${styles.envelope} ${isMasonInterjection(row) ? styles.interjection : ''}`} aria-label={isMasonInterjection(row) ? 'Interjection' : undefined}>
        <Tag size="sm">{row.priority}</Tag><span>{row.from} → {row.to}</span><Tag size="sm">{row.kind}</Tag>
        {row.kind === 'interjection' && row.channel && <Tag size="sm">via {channelLabels[row.channel]}</Tag>}
        <span className={styles.text}>{row.excerpt}</span>{row.expired && <Tag size="sm">expired</Tag>}
        <time className={styles.time} dateTime={row.at} title={new Date(row.at).toLocaleString()}>{row.ageText}</time>
        {row.from !== 'mason' && <Button size="sm" variant="subtle" onClick={() => setPrefill({ to: row.from, replyTo: row.id, quote: row.excerpt })}>Reply</Button>}
      </li>)}</ol> : status.data && page.data && <p className={styles.message}>{messages.length ? 'No events match this filter.' : 'No durable bus messages yet.'}</p>}
    {olderBoundary !== null && olderBoundary > 0 && <Button size="sm" onClick={() => { void loadOlder(); }} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older'}</Button>}
    <BusPostBox senders={recentSenders(allRows)} prefill={prefill} onPosted={cursor => {
      refreshPostedStatus(); refreshPostedPage();
      // The cursor can exceed retainedCount after pruning; fetch the new row directly in that case.
      if (cursor > after + PAGE_LIMIT) void agentBusPageQuery(cursor - 1).fetch().then(result => {
        if (result) setMessages(current => [...new Map([...current, ...result.messages].map(row => [row.cursor, row])).values()]);
      }).catch(() => {});
    }} />
  </section>;
}
