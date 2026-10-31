import { useMemo, useState } from 'react';
import { Button, SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fleetSteeringQuery } from './fleet-steering-queries.js';
import styles from './fleet-steering.module.css';
import { leaderJournalQuery } from '../leader-journal/leader-journal-queries.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { lastExchange, pendingOrders, pendingText } from './last-exchange-model.js';
import { buildSteering, citedJobsLine, fleetSourceHealth, summarizeReaction, type SteeringEntry } from './steering-model.js';

import { ordersTraceQuery } from '../fleet-inbox/fleet-inbox-queries.js';
import { githubUrl, jobsForEntry, narrowOrderTrace, stateWord, type OrderTraceV1 } from '../fleet-inbox/order-trace-model.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { splitRefs } from '../fleet/job-refs.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { openDockPane } from '../dock/dock-store.js';
import inboxStyles from '../fleet-inbox/fleet-inbox.module.css';

function openLog(id: string) {
  if (!JOB_ID_RE.test(id)) return;
  requestWorkerLogJob(id);
  openDockPane('worker-log');
}

const PREVIEW_CHARS = 160;

function reactionLine(entry: SteeringEntry): string {
  const summary = summarizeReaction(entry);
  const minutes = entry.firstReactionMinutes;
  if (minutes === null) return summary;
  return `${summary} · leaders reacted in ${minutes < 1 ? '<1' : Math.round(minutes)} min`;
}

function EntryRow({ entry, trace }: { entry: SteeringEntry; trace: OrderTraceV1 | null }) {
  const jobs = jobsForEntry(trace, entry.at);
  const [open, setOpen] = useState(false);
  const preview = entry.text.length > PREVIEW_CHARS ? `${entry.text.slice(0, PREVIEW_CHARS)}…` : entry.text;
  return (
    <li className={styles.row}>
      <div className={styles.meta}>
        <time className={styles.time}>{entry.at}</time>
        <Tag size="sm">{entry.source}</Tag>
        <Button size="sm" variant="subtle" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide events' : 'Events'}
        </Button>
      </div>
      {preview !== '' && <p className={styles.text}>{preview}</p>}
      <p className={styles.reaction}>{reactionLine(entry)}</p>
      <p className={styles.reaction}>{citedJobsLine(jobs, entry.firstReactionMinutes)}</p>
      {jobs.length > 0 && <div className={inboxStyles.jobs}>
        {jobs.slice(0, 6).map((job, index) => {
          const href = githubUrl(job), word = stateWord(job), refs = splitRefs(job.id);
          return <span className={inboxStyles.jobChip} key={`${job.id}-${index}`}>
            {job.state === 'queued' || !JOB_ID_RE.test(job.id) ? job.id
              : refs.length === 1 && refs[0]?.kind === 'job' ? <JobRefs text={job.id} onOpenJob={openLog} />
                : <button type="button" onClick={() => openLog(job.id)} aria-label={`Open log for ${job.id}`}>{job.id}</button>}
            {' '}{href && word.startsWith('PR #') ? <a href={href} target="_blank" rel="noreferrer">{word}</a> : word}
            {href && !word.startsWith('PR #') && <> <a href={href} target="_blank" rel="noreferrer">View on GitHub</a></>}
          </span>;
        })}
        {jobs.length > 6 && <span>+{jobs.length - 6} more</span>}
      </div>}
      {open && (entry.events.length > 0
        ? (
          <ol className={styles.events} aria-label={`Events after ${entry.at}`}>
            {entry.events.map((event, index) => (
              <li key={`${event.at}:${event.kind}:${index}`} className={styles.event}>
                <time className={styles.time}>{event.at.slice(11, 19)}</time>
                <Tag size="sm">{event.kind}</Tag>
                <span className={styles.eventText}>{event.text}</span>
              </li>
            ))}
          </ol>
        )
        : <p className={styles.reaction}>No dispatcher events in this window.</p>)}
    </li>
  );
}

export function FleetSteeringPane({ visible }: PaneProps) {
  const read = useQuery(fleetSteeringQuery, { enabled: visible, freshMs: 0 });
  const orders = useQuery(ordersTraceQuery, { enabled: visible, freshMs: 30_000 });
  const trace = orders.error ? null : narrowOrderTrace(orders.data);
  const journal = useQuery(leaderJournalQuery, { enabled: visible });
  const refetchJournal = useRefetch(leaderJournalQuery);
  usePollWhileVisible(refetchJournal, 30_000, { enabled: visible });
  const refetch = useRefetch(fleetSteeringQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  const entries = useMemo(() => buildSteering(read.data), [read.data]);
  const nowMs = Date.now();
  const exchange = lastExchange(entries, journal.data, nowMs);
  const pending = pendingText(pendingOrders(read.data, nowMs));
  const missing = read.data === null || (read.error instanceof ApiError && read.error.status === 404);
  if (missing) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) {
    return (
      <div className={styles.root} role="status">
        {read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}
      </div>
    );
  }
  const sources = fleetSourceHealth(read.data);
  const degraded = sources.inbox !== 'healthy' || sources.runsDir !== 'healthy';
  return (
    <section className={styles.root} aria-label="Steering">
      <p role="status" aria-label="Pending orders" className={styles.text} data-tone={pending.tone}
        style={{ color: pending.tone === 'danger' ? 'var(--status-danger-fg)' : pending.tone === 'warning' ? 'var(--status-warning-fg)' : undefined }}>
        {pending.text}
      </p>
      <Button size="sm" onClick={() => openInterjectDialog()}>Send another</Button>
      <p role="status" aria-label="Last exchange" className={styles.text} data-tone={exchange.tone}
        style={{ color: exchange.tone === 'danger' ? 'var(--status-danger-fg)' : exchange.tone === 'warning' ? 'var(--status-warning-fg)' : undefined }}>
        {exchange.text}
      </p>
      {journal.status === 'error' && <p className={styles.notice} role="status">Leader journal could not refresh.</p>}
      {degraded && <p className={styles.notice} role="status">{sources.runsDir === 'missing'
        ? 'No fleet on this Mac yet (~/.ashlr-runs not found).'
        : 'Inbox or dispatcher events may be incomplete.'}</p>}
      {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
      {entries.length === 0
        ? <p className={styles.message}>No orders yet. Use the interject box.</p>
        : (
          <ol className={styles.list} aria-label="Steering orders">
            {entries.map((entry, index) => <EntryRow key={`${entry.at}:${index}`} entry={entry} trace={trace} />)}
          </ol>
        )}
    </section>
  );
}
