import { useMemo, useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { Button } from '../../../components/primitives/index.js';
import { JOB_ID_RE } from './worker-log-model.js';
import { jobActivityQuery } from './job-activity-queries.js';
import {
  activityCountsLine, entryKindLabel, eventTimeLabel, filterActivityEntries,
  type JobActivityEntry, type JobActivityFilesEntry, type JobActivityV1,
} from './job-activity-model.js';
import styles from './worker-log.module.css';

/**
 * The per-job Activity stream (RQ-RADAR-DESKTOP-ACTIVITY): one searchable
 * list merging ledger events, commands seen in the worker log, the job's
 * changed files and its reports — reports render as Markdown inline.
 */
export function JobActivity({ job, enabled, pollMs }: { job: string; enabled: boolean; pollMs: number }) {
  const valid = JOB_ID_RE.test(job);
  const query = useMemo(() => jobActivityQuery(job), [job]);
  const activity = useQuery(query, { enabled: enabled && valid, freshMs: 0 });
  const refetch = useRefetch(query);
  const refresh = useRefresh(query);
  usePollWhileVisible(refetch, pollMs, { enabled: enabled && valid, refreshOnShow: false });
  const [filter, setFilter] = useState('');
  const data = activity.data;
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const visible = useMemo(() => filterActivityEntries(entries, filter), [entries, filter]);
  const filtering = filter.trim() !== '';
  const sourceHint = activitySourceHint(data);

  return <section className={styles.activity} aria-label="Job activity">
    <div className={styles.activityHead}>
      <strong>Activity</strong>
      {data ? <span className={styles.hint}>{activityCountsLine(data)}{data.truncated ? ' · window truncated' : ''}</span> : null}
      <label className={styles.activityFilter}>Filter <input type="search" aria-label="Filter activity" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <Button size="sm" variant="subtle" aria-label="Refresh activity" disabled={!enabled || !valid} onClick={refresh}>Refresh</Button>
    </div>
    {activity.status === 'error' && <p role="status">Activity could not refresh.</p>}
    {sourceHint !== null && <p className={styles.hint} role="status">{sourceHint}</p>}
    {data === null && <p className={styles.hint}>The activity API has not landed in this build yet.</p>}
    {data === undefined && activity.status !== 'error' && <p className={styles.hint}>Reading activity…</p>}
    {data && entries.length === 0 && <p className={styles.hint}>No activity recorded yet.</p>}
    {data && entries.length > 0 && (visible.length === 0
      ? <p className={styles.hint}>No activity entries match “{filter.trim()}”.</p>
      : <ol className={styles.stream}>
        {visible.map((entry, index) => <ActivityRow key={rowKey(entry, index)} entry={entry} />)}
      </ol>)}
    {data && filtering && visible.length > 0 && visible.length < entries.length
      ? <p className={styles.hint}>{visible.length} of {entries.length} entries</p> : null}
  </section>;
}

function rowKey(entry: JobActivityEntry, index: number): string {
  switch (entry.kind) {
    case 'event': return `event:${entry.at ?? ''}:${entry.event}:${index}`;
    case 'command': return `command:${entry.line}:${index}`;
    case 'files': return 'files';
    case 'report': return `report:${entry.name}`;
  }
}

function ActivityRow({ entry }: { entry: JobActivityEntry }) {
  return <li className={styles.streamRow} data-kind={entry.kind}>
    <span className={styles.streamKind}>{entryKindLabel(entry)}</span>
    <ActivityBody entry={entry} />
  </li>;
}

function ActivityBody({ entry }: { entry: JobActivityEntry }) {
  switch (entry.kind) {
    case 'event':
      return <span className={styles.streamEvent}>
        {eventTimeLabel(entry.at) !== '' && <span className={styles.streamTime}>{eventTimeLabel(entry.at)} </span>}
        <code>{entry.event}</code>
        {entry.summary !== '' && <span className={styles.streamSummary}> {entry.summary}</span>}
      </span>;
    case 'command':
      return <code className={styles.streamCommand}>{entry.text}<span className={styles.streamLine}> · log line {entry.line}</span></code>;
    case 'files':
      return <FilesBody entry={entry} />;
    case 'report':
      return <ReportBody entry={entry} />;
  }
}

function FilesBody({ entry }: { entry: JobActivityFilesEntry }) {
  if (entry.state === 'missing') return <span className={styles.hint}>No worktree on disk.</span>;
  return <div className={styles.streamFiles}>
    <div>{entry.totals.files} {entry.totals.files === 1 ? 'file' : 'files'} · +{entry.totals.added} −{entry.totals.removed}{entry.baseSha ? ` · vs base ${entry.baseSha.slice(0, 7)}` : ' · vs HEAD'}{entry.comparisonBase === 'HEAD' ? ' (HEAD)' : ''}{entry.state === 'degraded' ? ' · partial' : ''}</div>
    {entry.files.length > 0 && <ul>
      {entry.files.map(file => <li key={file.path} className={styles.file}>
        <code>{file.path}</code><span>+{file.added ?? '?'} −{file.removed ?? '?'}</span>{file.status === 'untracked' && <span>untracked</span>}
      </li>)}
    </ul>}
    {entry.truncated && <p className={styles.hint}>Showing a limited set of changes.</p>}
  </div>;
}

function ReportBody({ entry }: { entry: Extract<JobActivityEntry, { kind: 'report' }> }) {
  const label = entry.name === 'notes' ? 'Notes' : 'Brief';
  if (entry.state === 'missing') return <span className={styles.hint}>{label}: none on disk.</span>;
  if (entry.state === 'unreadable' || entry.text === '') return <span className={styles.hint}>{label}: could not read.</span>;
  return <div className={styles.streamReport}>
    <div className={styles.streamReportHead}>{label}{entry.source === 'body' ? ' (body)' : ''}{entry.truncated ? ' · truncated' : ''}</div>
    <MessageMarkdown text={entry.text} />
  </div>;
}

function activitySourceHint(activity: JobActivityV1 | null | undefined): string | null {
  const degraded = (['events', 'commands', 'files', 'reports'] as const)
    .filter(key => activity?.sources?.[key] === 'degraded');
  if (!activity || degraded.length === 0) return null;
  return `Partial activity: ${degraded.join(', ')} could not be read.`;
}
