import { useState } from 'react';
import { Button, EmptyState, Input, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { filterEntries, groupByDay, quoteForMessage, readInboxEntries } from './fleet-inbox-model.js';
import { fleetInboxQuery, fleetRunsQuery } from './fleet-inbox-queries.js';
import styles from './fleet-inbox.module.css';

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
export function FleetInboxPane({ visible, host }: PaneProps) {
  const route = useQuery(fleetInboxQuery);
  const routeInbox = readInboxEntries(route.data, undefined);
  const fallback = routeInbox.origin === 'none' && (route.status === 'error' || route.status === 'success');
  const snapshot = useQuery(fleetRunsQuery, { enabled: fallback });
  const refreshRoute = useRefetch(fleetInboxQuery), refreshSnapshot = useRefetch(fleetRunsQuery);
  usePollWhileVisible(() => { refreshRoute(); if (fallback) refreshSnapshot(); }, 10_000, { enabled: visible });
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const inbox = readInboxEntries(route.data, snapshot.data);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const groups = groupByDay(filterEntries(inbox.entries, { source, text }), today);
  const loading = inbox.origin === 'none' && (!fallback || snapshot.status === 'idle' || snapshot.status === 'loading');
  if (loading) return <div className={styles.pane} role="status" aria-label="Loading inbox"><SkeletonLine /><SkeletonLine /><SkeletonLine /></div>;
  if (inbox.origin === 'none') return <EmptyState compact title={notFound(route.error) && notFound(snapshot.error) ? 'Inbox not in this build' : 'Inbox unavailable'} />;
  return <div className={styles.pane}>
    {(inbox.sourceState !== 'healthy' || (route.error && !notFound(route.error)) || snapshot.error) &&
      <p className={styles.banner} role="status">Inbox degraded ({inbox.sourceState}). Showing the entries last read.</p>}
    <Input aria-label="Filter inbox text" placeholder="Filter orders…" value={text} onChange={e => setText(e.target.value)} />
    <div className={styles.filters} aria-label="Filter by source">
      {['', ...new Set(inbox.entries.map(e => e.source))].map(s => <Button key={s} size="sm" aria-pressed={source === s} onClick={() => setSource(s)}>{s || 'All sources'}</Button>)}
    </div>
    {groups.length === 0 && <EmptyState compact title={inbox.entries.length ? 'No matching orders' : 'No orders yet'} />}
    {groups.map(group => <section key={group.day} aria-label={group.label}>
      <h3 className={styles.day}>{group.label}{group.day !== '—' && ' · ET'}</h3>
      {group.entries.map((entry, i) => <article className={styles.row} key={`${entry.at}-${i}`}>
        <div className={styles.meta}><time>{entry.at === '—' ? '—' : `${entry.at.slice(11)} ET`}</time><Tag>{entry.source}</Tag>{entry.priority !== 'P0' && <Tag>{entry.priority}</Tag>}</div>
        <p className={styles.text}>{entry.text}</p>
        <Button size="sm" onClick={() => host.addToMessage(quoteForMessage(entry))}>Add to message</Button>
      </article>)}
    </section>)}
  </div>;
}
