import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { JOB_ID_RE, jobOptions, metaLine, pollMs, prLabel, safePrUrl, stateTone } from './worker-log-model.js';
import { jobDetailQuery } from './worker-log-queries.js';
import { takeRequestedWorkerLogJob, useRequestedWorkerLogJob } from './worker-log-selection.js';
import { jobChangesQuery } from './worker-changes-queries.js';
import { changesHeadline, sortFiles } from './worker-changes-model.js';
import styles from './worker-log.module.css';

export function WorkerLogPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const runs = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const refetchRuns = useRefetch(opsRunsQuery);
  const refreshRuns = useRefresh(opsRunsQuery);
  const options = jobOptions(runs.data);
  const [selection, setSelection] = useState<string | null>(null);
  const requestedJob = useRequestedWorkerLogJob();
  useEffect(() => {
    if (requestedJob === null) return;
    const requested = takeRequestedWorkerLogJob();
    if (requested !== null && requested !== selection) setSelection(requested);
  }, [requestedJob, selection]);
  const job = selection ?? options[0]?.job ?? '';
  useEffect(() => { if (requestedJob === null && selection === null && options[0]) setSelection(options[0].job); }, [requestedJob, selection, options]);
  const valid = JOB_ID_RE.test(job);
  const query = useMemo(() => jobDetailQuery(job), [job]);
  const detail = useQuery(query, { enabled: active && valid, freshMs: 0 });
  const changesQuery = useMemo(() => jobChangesQuery(job), [job]);
  const changes = useQuery(changesQuery, { enabled: active && valid, freshMs: 0 });
  const refetchChanges = useRefetch(changesQuery);
  const refreshChanges = useRefresh(changesQuery);
  usePollWhileVisible(refetchChanges, pollMs(detail.data), { enabled: visible && valid, refreshOnShow: false });
  const refetchDetail = useRefetch(query);
  const refreshDetail = useRefresh(query);
  usePollWhileVisible(refetchRuns, 5_000, { enabled: visible, refreshOnShow: false });
  usePollWhileVisible(refetchDetail, pollMs(detail.data), { enabled: visible && valid, refreshOnShow: false });
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const lines = detail.data?.log?.tail?.join('\n') ?? '';
  const truncated = detail.data?.log?.truncated === true;
  useEffect(() => { if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [follow, job, lines, truncated]);
  const retained = valid && !options.some(option => option.job === job);
  const url = safePrUrl(detail.data?.publish?.prUrl);
  const meta = detail.data ? metaLine(detail.data, Date.now()).split(' · ') : [];
  const state = detail.data?.state ?? 'unknown';

  return <div className={styles.pane} aria-label="Worker log">
    <div className={styles.controls}>
      <label>Worker <select aria-label="Worker" value={valid ? job : ''} onChange={event => setSelection(event.target.value)}>
        {!valid && <option value="">Select a worker</option>}
        {retained && <option value={job}>{job}</option>}
        {options.map(option => <option key={option.job} value={option.job}>{option.label}</option>)}
      </select></label>
      <label>Job ID <input aria-label="Job ID" value={job} onChange={event => setSelection(event.target.value)} aria-invalid={job !== '' && !valid} aria-describedby={job !== '' && !valid ? 'worker-log-id-hint' : undefined} /></label>
      <label className={styles.follow}><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow</label>
      <button type="button" onClick={() => { refreshRuns(); if (valid) { refreshDetail(); refreshChanges(); } }}>Refresh</button>
    </div>
    {job !== '' && !valid && <p id="worker-log-id-hint" className={styles.hint}>Use 3–80 letters, numbers, dots, underscores or hyphens, starting with a letter or number.</p>}
    {runs.status === 'error' && <p role="status">Workers could not refresh.</p>}
    {runs.data && options.length === 0 && <p className={styles.hint}>No workers running right now.</p>}
    {runs.data === null && <p className={styles.hint}>The worker list is not available in this build.</p>}
    {valid && detail.data === null && <p>The job detail API has not landed in this build yet.</p>}
    {valid && detail.status === 'error' && <p role="status">Job detail could not refresh.</p>}
    {valid && detail.data && <>
      <div className={styles.meta}><StatusBadge status={state} tone={stateTone(state)}>{state}</StatusBadge>
        {meta.slice(1).map((part, index) => <span key={`${part}-${index}`}> · {url && index === meta.length - 2 && part === prLabel(url) ? <a href={url} target="_blank" rel="noreferrer">{part}</a> : part}</span>)}
      </div>
      {detail.data.log?.source === 'missing' || !detail.data.log ? <p className={styles.hint}>No log yet.</p> :
        <pre ref={logRef} className={styles.log} role="log" aria-live="polite">{[truncated ? '… earlier lines not shown' : null, lines].filter(value => value !== null).join('\n')}</pre>}
      {changes.data && <section aria-label="Changes" className={styles.changes}>
        <div>{changesHeadline(changes.data)}</div>
        {changes.data.state === 'missing' ? <p>Worktree not available</p> : <>
          {changes.data.state === 'degraded' && <p role="status">Changes could not fully refresh.</p>}
          {changes.data.files.length === 0 && changes.data.state === 'live' ? <p>No changes yet</p> : <ul>
            {sortFiles(changes.data.files).map(file => <li key={file.path} className={styles.file}><code>{file.path}</code><span>+{file.added ?? '?'} −{file.removed ?? '?'}</span>{file.status === 'untracked' && <span>untracked</span>}</li>)}
          </ul>}
          {changes.data.truncated && <p>Showing a limited set of changes.</p>}
        </>}
      </section>}
    </>}
    {valid && detail.data === undefined && detail.status !== 'error' && <p role="status">Reading worker log…</p>}
  </div>;
}
