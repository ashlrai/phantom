import { useEffect, useState } from 'react';
import { Button, EmptyState, Input, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { filterEntries, groupByDay, quoteForMessage, readInboxEntries } from './fleet-inbox-model.js';
import { fleetInboxQuery, fleetRunsQuery } from './fleet-inbox-queries.js';
import { InboxPostBox } from './InboxPostBox.js';
import { matchesPosted } from './inbox-post-model.js';
import { annotateAck, seenCounts } from './inbox-ack-model.js';
import styles from './fleet-inbox.module.css';

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
export function FleetInboxPane({ visible, host }: PaneProps) {
  const route = useQuery(fleetInboxQuery);
  const routeInbox = readInboxEntries(route.data, undefined);
  const fallback = routeInbox.origin === 'none' && (route.status === 'error' || route.status === 'success');
  const snapshot = useQuery(fleetRunsQuery);
  const refreshRoute = useRefetch(fleetInboxQuery), refreshSnapshot = useRefetch(fleetRunsQuery);
  usePollWhileVisible(refreshRoute, 10_000, { enabled: visible });
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [posted, setPosted] = useState<{ text: string; until: number } | null>(null);
  const [postedForAck, setPostedForAck] = useState<string | null>(null);
  const sectionVisible = useSectionVisible(), documentVisible = useDocumentVisible();
  useEffect(() => {
    if (!posted || !visible || !sectionVisible || !documentVisible) return;
    const timer = setTimeout(() => setPosted(null), Math.max(0, posted.until - Date.now()));
    return () => clearTimeout(timer);
  }, [posted, visible, sectionVisible, documentVisible]);
  const inbox = readInboxEntries(route.data, fallback ? snapshot.data : undefined);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const annotated = annotateAck(filterEntries(inbox.entries, { source, text }), snapshot.data, Date.now());
  const groups = groupByDay(annotated, today);
  const { waiting } = seenCounts(annotated);
  const matching = posted && posted.until > Date.now() && visible && sectionVisible && documentVisible
    ? annotated.filter(entry => matchesPosted(entry, posted.text)) : [];
  // The dedicated route is oldest-first; the fallback snapshot is newest-first.
  const highlighted = matching.reduce<(typeof matching)[number] | undefined>((newest, entry) =>
    !newest || (entry.at !== '—' && (newest.at === '—' || entry.at > newest.at))
      || (entry.at === newest.at && inbox.origin === 'route') ? entry : newest, undefined);
  const latestPosted = postedForAck ? annotateAck(inbox.entries.filter(entry => matchesPosted(entry, postedForAck)), snapshot.data, Date.now())
    .reduce<(typeof annotated)[number] | undefined>((newest, entry) =>
      !newest || (entry.at !== '—' && (newest.at === '—' || entry.at > newest.at))
        || (entry.at === newest.at && inbox.origin === 'route') ? entry : newest, undefined) : undefined;
  usePollWhileVisible(refreshSnapshot, latestPosted?.ack === 'waiting' ? 15_000 : 10_000, { enabled: visible });
  const loading = inbox.origin === 'none' && (!fallback || snapshot.status === 'idle' || snapshot.status === 'loading');
  return <div className={styles.pane}>
    <InboxPostBox onPosted={postedText => {
      setSource(''); setText(''); setPosted({ text: postedText, until: Date.now() + 5_000 }); setPostedForAck(postedText);
      void refetchQuery(fleetInboxQuery.key, () => fleetInboxQuery.fetch(), true);
      if (fallback) void refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true);
    }} />
    {loading ? <div role="status" aria-label="Loading inbox"><SkeletonLine /><SkeletonLine /><SkeletonLine /></div>
      : inbox.origin === 'none' ? <EmptyState compact title={notFound(route.error) && notFound(snapshot.error) ? 'Inbox not in this build' : 'Inbox unavailable'} /> : <>
    {(inbox.sourceState !== 'healthy' || (route.error && !notFound(route.error)) || (fallback && snapshot.error)) &&
      <p className={styles.banner} role="status">Inbox degraded ({inbox.sourceState}). Showing the entries last read.</p>}
    {waiting > 0 && <p role="status">{waiting} waiting for a leader pass</p>}
    <Input aria-label="Filter inbox text" placeholder="Filter orders…" value={text} onChange={e => setText(e.target.value)} />
    <div className={styles.filters} aria-label="Filter by source">
      {['', ...new Set(inbox.entries.map(e => e.source))].map(s => <Button key={s} size="sm" aria-pressed={source === s} onClick={() => setSource(s)}>{s || 'All sources'}</Button>)}
    </div>
    {groups.length === 0 && <EmptyState compact title={inbox.entries.length ? 'No matching orders' : 'No orders yet'} />}
    {groups.map(group => <section key={group.day} aria-label={group.label}>
      <h3 className={styles.day}>{group.label}{group.day !== '—' && ' · ET'}</h3>
      {group.entries.map((entry, i) => <article className={`${styles.row}${entry === highlighted ? ` ${styles.highlight}` : ''}`} key={`${entry.at}-${i}`}>
        <div className={styles.meta}><time>{entry.at === '—' ? '—' : `${entry.at.slice(11)} ET`}</time><Tag>{entry.sourceLabel}</Tag><Tag className={styles[entry.ack]}>{entry.ackLabel}</Tag>{entry.priority !== 'P0' && <Tag>{entry.priority}</Tag>}</div>
        <p className={styles.text}>{entry.text}</p>
        <Button size="sm" onClick={() => host.addToMessage(quoteForMessage(entry))}>Add to message</Button>
      </article>)}
    </section>)}
    </>}
  </div>;
}
