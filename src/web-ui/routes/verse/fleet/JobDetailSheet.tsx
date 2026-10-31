import { useId } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { runQuery } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../autonomy/format.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { jobChangesQuery } from '../fleet-job-log/worker-changes-queries.js';
import { changesHeadline, sortFiles, type FleetJobChangesV1 } from '../fleet-job-log/worker-changes-model.js';
import { openInterjectDialog } from './interject-dialog-store.js';
import { sheetActions, steerPrefill } from './job-sheet-actions.js';
import { jobDetailQuery, notInBuild } from './workers-card-queries.js';
import styles from './workers-card.module.css';

const tones: Record<string, Tone> = { running: 'success', published: 'info', archived: 'neutral', unknown: 'warning' };
const fileStatus: Record<FleetJobChangesV1['files'][number]['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: '?' };
export function JobDetailSheet({ job, onClose }: { job: string; onClose: () => void }) {
  const id = useId();
  const query = jobDetailQuery(job);
  const read = useQuery(query);
  const changesQuery = jobChangesQuery(job);
  const changes = useQuery(changesQuery, { freshMs: 0 });
  usePollWhileVisible(() => { void runQuery(query.key, () => query.fetch()); }, 5_000, { enabled: !notInBuild(read.error) });
  usePollWhileVisible(() => { void runQuery(changesQuery.key, () => changesQuery.fetch()); }, 5_000, { enabled: read.data?.state === 'running' });
  const d = read.data;
  const facts = d ? [['Lane', d.lane], ['Tier', d.tier], ['Model', d.model], ['Launched', formatRelative(d.launchedAt)], ['Base', d.baseSha?.slice(0, 7)], ['Branch', d.branch]] : [];
  return <Sheet open titleId={id} title={job} onClose={onClose}>
    {read.status === 'refreshing' ? <RefreshIndicator /> : null}
    {d ? <StatusBadge status={d.state} tone={tones[d.state]} /> : null}
    <div role="group" aria-label="Job actions" className={styles.actions}>
      {sheetActions(job, d).map(action => action.href
        ? <a key={action.id} href={action.href} target="_blank" rel="noopener noreferrer">{action.label}</a>
        : <Button key={action.id} size="sm" onClick={() => {
          if (action.id === 'log') { requestWorkerLogJob(job); openDockPane('worker-log'); }
          else { openInterjectDialog({ prefill: steerPrefill(job, d?.lane) }); }
          onClose();
        }}>{action.label}</Button>)}
    </div>
    {notInBuild(read.error) ? <p>Job detail is not in this build yet.</p> : read.error ? <p>Job detail unavailable.</p> : !d ? <SkeletonLine /> : <>
      <dl className={styles.facts}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd aria-label={`${label} ${value ?? 'unknown'}`}>{value ?? '—'}</dd></div>)}</dl>
      {d.publish?.prUrl ? <p><a href={d.publish.prUrl} target="_blank" rel="noreferrer">PR for job {job}</a></p> : null}
      {d.publish?.autoMerge != null ? <p>Auto-merge {d.publish.autoMerge ? 'on' : 'off'}</p> : null}
      <p>Notes present: {d.hasNotes === null ? 'unknown' : d.hasNotes ? 'yes' : 'no'}</p>
      <section aria-label="Changed files">
        <h3>Changed files</h3>
        {changes.error ? <p role="status">Changes unavailable</p> : changes.data === null ? <p>Changes are not in this build yet</p> : !changes.data ? <SkeletonLine /> : <>
          <p>{changesHeadline(changes.data)}</p>
          {changes.data.state === 'missing' ? <p>Worktree not available</p> : <>
            {changes.data.state === 'degraded' && <p role="status">Changes could not fully refresh.</p>}
            {changes.data.files.length === 0 ? (changes.data.state === 'live' ? <p>No changes yet</p> : null) : <ul>
              {sortFiles(changes.data.files).slice(0, 40).map(file => <li key={file.path}><code>{fileStatus[file.status]} {file.path}</code></li>)}
            </ul>}
            {changes.data.files.length > 40 && <p>+{changes.data.files.length - 40} more</p>}
            {changes.data.truncated && <p>Showing a limited set of changes.</p>}
          </>}
        </>}
      </section>
      {d.log.source === 'missing' ? <p>No log yet.</p> : <><h3>Log tail ({d.log.source}, {d.log.tail.length} lines{d.log.truncated ? ', truncated' : ''})</h3>
        <pre className={styles.log}>{d.log.tail.join('\n')}</pre></>}
    </>}
  </Sheet>;
}
