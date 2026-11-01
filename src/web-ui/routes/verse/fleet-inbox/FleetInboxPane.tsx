import { useEffect, useState } from 'react';
import { Button, EmptyState, Input, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { refetchQuery } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { channelKey, channelLabel, type ChannelKey } from '../fleet-channels/fleet-channels-model.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { splitRefs } from '../fleet/job-refs.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { filterEntries, groupByDay, quoteForMessage, readInboxEntries } from './fleet-inbox-model.js';
import { fleetInboxQuery, fleetRunsQuery, ordersTraceQuery } from './fleet-inbox-queries.js';
import { githubUrl, jobsForEntry, narrowOrderTrace, orderJobsLine, stateWord } from './order-trace-model.js';
import { InboxPostBox } from './InboxPostBox.js';
import { matchesPosted } from './inbox-post-model.js';
import { annotateAck, seenCounts } from './inbox-ack-model.js';
import { canResend, resendPrefill } from './inbox-resend.js';
import { takeRequestedInboxChannel, useRequestedInboxChannel } from './inbox-source-request.js';
import styles from './fleet-inbox.module.css';

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
export function FleetInboxPane({ visible, host }: PaneProps) {
  const route = useQuery(fleetInboxQuery);
  const routeInbox = readInboxEntries(route.data, undefined);
  const fallback = routeInbox.origin === 'none' && (route.status === 'error' || route.status === 'success');
  const snapshot = useQuery(fleetRunsQuery);
  const sectionVisible = useSectionVisible(), documentVisible = useDocumentVisible();
  const orders = useQuery(ordersTraceQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 10_000 });
  const trace = orders.error ? null : narrowOrderTrace(orders.data);
  const refreshOrders = useRefetch(ordersTraceQuery);
  const refreshRoute = useRefetch(fleetInboxQuery), refreshSnapshot = useRefetch(fleetRunsQuery);
  usePollWhileVisible(refreshRoute, 10_000, { enabled: visible });
  usePollWhileVisible(refreshOrders, 15_000, { enabled: visible });
  const [source, setSource] = useState('');
  const [channel, setChannel] = useState<ChannelKey | null>(null);
  const requestedChannel = useRequestedInboxChannel();
  useEffect(() => {
    if (requestedChannel === null) return;
    const requested = takeRequestedInboxChannel();
    if (requested !== null) { setSource(''); setChannel(requested); }
  }, [requestedChannel]);
  const [text, setText] = useState('');
  const [posted, setPosted] = useState<{ text: string; until: number } | null>(null);
  const [postedForAck, setPostedForAck] = useState<string | null>(null);
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!posted || !visible || !sectionVisible || !documentVisible) return;
    const timer = setTimeout(() => setPosted(null), Math.max(0, posted.until - Date.now()));
    return () => clearTimeout(timer);
  }, [posted, visible, sectionVisible, documentVisible]);
  const inbox = readInboxEntries(route.data, fallback ? snapshot.data : undefined);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const entries = channel === null ? inbox.entries : inbox.entries.filter(entry => channelKey(entry.source) === channel);
  const annotated = annotateAck(filterEntries(entries, { source, text }), snapshot.data, Date.now());
  const groups = groupByDay(annotated, today);
  const { waiting, overdue } = seenCounts(annotated);
  usePollWhileVisible(() => setClockTick(tick => tick + 1), 10_000, { enabled: visible && waiting > 0 });
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
  function openLog(id: string) {
    if (!JOB_ID_RE.test(id)) return;
    requestWorkerLogJob(id);
    openDockPane('worker-log');
  }
  return <div className={styles.pane}>
    <InboxPostBox snapshot={snapshot.data} onPosted={postedText => {
      setSource(''); setChannel(null); setText(''); setPosted({ text: postedText, until: Date.now() + 5_000 }); setPostedForAck(postedText);
      void refetchQuery(fleetInboxQuery.key, () => fleetInboxQuery.fetch(), true);
      if (fallback) void refetchQuery(fleetRunsQuery.key, () => fleetRunsQuery.fetch(), true);
    }} />
    {channel !== null && <p><Tag>Filtered to {channelLabel(channel)} · <Button size="sm" onClick={() => { setChannel(null); setSource(''); }}>Clear</Button></Tag></p>}
    {loading ? <div role="status" aria-label="Loading inbox"><SkeletonLine /><SkeletonLine /><SkeletonLine /></div>
      : inbox.origin === 'none' ? <EmptyState compact title={notFound(route.error) && notFound(snapshot.error) ? 'Inbox not in this build' : 'Inbox unavailable'} /> : <>
    {(inbox.sourceState !== 'healthy' || (route.error && !notFound(route.error)) || (fallback && snapshot.error)) &&
      <p className={styles.banner} role="status">Inbox degraded ({inbox.sourceState}). Showing the entries last read.</p>}
    {waiting > 0 && <p role="status">{waiting} waiting for a leader pass{overdue && ' · leader pass overdue'}</p>}
    <Input aria-label="Filter inbox text" placeholder="Filter orders…" value={text} onChange={e => setText(e.target.value)} />
    <div className={styles.filters} aria-label="Filter by source">
      {['', ...new Set(inbox.entries.map(e => e.source))].map(s => <Button key={s} size="sm" aria-pressed={channel === null && source === s} onClick={() => { setChannel(null); setSource(s); }}>{s || 'All sources'}</Button>)}
    </div>
    {groups.length === 0 && <EmptyState compact title={inbox.entries.length ? 'No matching orders' : 'No orders yet'} />}
    {groups.map(group => <section key={group.day} aria-label={group.label}>
      <h3 className={styles.day}>{group.label}{group.day !== '—' && ' · ET'}</h3>
      {group.entries.map((entry, i) => { const jobs = jobsForEntry(trace, entry.at); return <article className={`${styles.row}${entry === highlighted ? ` ${styles.highlight}` : ''}`} key={`${entry.at}-${i}`}>
        <div className={styles.meta}><time>{entry.at === '—' ? '—' : `${entry.at.slice(11)} ET`}</time><Tag>{entry.sourceLabel}</Tag><Tag className={styles[entry.ack]} data-overdue={entry.ack === 'waiting' && entry.eta.kind === 'overdue' ? true : undefined}>{entry.ackLabel}</Tag>{entry.priority !== 'P0' && <Tag>{entry.priority}</Tag>}</div>
        <p className={styles.text}>{entry.text}</p>
        {jobs.length > 0 && <div className={styles.jobs}>
          <span>{orderJobsLine(jobs)}</span>
          {jobs.slice(0, 6).map((job, index) => {
            const href = githubUrl(job), word = stateWord(job), refs = splitRefs(job.id);
            return <span className={styles.jobChip} key={`${job.id}-${index}`}>
              {job.state === 'queued' || !JOB_ID_RE.test(job.id) ? job.id
                : refs.length === 1 && refs[0]?.kind === 'job' ? <JobRefs text={job.id} onOpenJob={openLog} />
                  : <button type="button" onClick={() => openLog(job.id)} aria-label={`Open log for ${job.id}`}>{job.id}</button>}
              {' '}{href && word.startsWith('PR #') ? <a href={href} target="_blank" rel="noreferrer">{word}</a> : word}
              {href && !word.startsWith('PR #') && <> <a href={href} target="_blank" rel="noreferrer">View on GitHub</a></>}
            </span>;
          })}
          {jobs.length > 6 && <span>+{jobs.length - 6} more</span>}
        </div>}
        <Button size="sm" onClick={() => host.addToMessage(quoteForMessage(entry))}>Add to message</Button>
        {canResend(entry) && <Button size="sm" variant="ghost" aria-label={`Resend order from ${entry.at.slice(11)}`} onClick={() => openInterjectDialog({ prefill: resendPrefill(entry) })}>Resend</Button>}
      </article>; })}
    </section>)}
    </>}
  </div>;
}
