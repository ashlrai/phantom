import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { JOB_ID_RE, jobOptions, metaLine, pollMs, prLabel, safePrUrl, stateTone } from './worker-log-model.js';
import { jobDetailQuery } from './worker-log-queries.js';
import { workerLogMarkdown } from './worker-log-markdown.js';
import { takeRequestedWorkerLogJob, useRequestedWorkerLogJob } from './worker-log-selection.js';
import { jobChangesQuery } from './worker-changes-queries.js';
import { changesHeadline, sortFiles } from './worker-changes-model.js';
import { findMatches, matchLabel, nextMatch } from './log-find-model.js';
import { jobTextQuery } from './job-text-queries.js';
import styles from './worker-log.module.css';

const EMPTY_LINES: string[] = [];

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
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice !== 'Copied') return;
    const timer = setTimeout(() => setNotice(''), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const copy = async () => {
    if (!valid || !detail.data) return;
    try { await navigator.clipboard.writeText(workerLogMarkdown(job, detail.data, Date.now())); setNotice('Copied'); }
    catch { setNotice('Copy failed'); }
  };
  const [follow, setFollow] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [selectedMatch, setSelectedMatch] = useState<number | null>(null);
  const lines = detail.data?.log?.tail ?? EMPTY_LINES;
  const text = lines.join('\n');
  const matches = useMemo(() => findMatches(lines, search), [lines, search]);
  const matchedLines = useMemo(() => new Set(matches), [matches]);
  const current = selectedMatch !== null && matches.includes(selectedMatch) ? selectedMatch : matches[0] ?? null;
  const truncated = detail.data?.log?.truncated === true;
  useEffect(() => { if (follow && !search && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [follow, job, text, truncated, search]);
  useEffect(() => {
    if (current !== null) logRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'center' });
  }, [current, job, search, text]);
  const moveMatch = (dir: 1 | -1) => setSelectedMatch(nextMatch(matches, current, dir));
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
      <label>Find in log <input type="search" aria-label="Find in log" value={search} onChange={event => { setSearch(event.target.value); setSelectedMatch(null); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { setSearch(''); setSelectedMatch(null); }
      }} /></label>
      <Button size="sm" variant="subtle" aria-label="Copy as Markdown" disabled={!valid || !detail.data} onClick={() => void copy()}>Copy as Markdown</Button><span role="status">{notice}</span>
      <span aria-live="polite">{search ? matchLabel(matches, current) : ''}</span>
      <button type="button" aria-label="Previous" disabled={matches.length === 0} onClick={() => moveMatch(-1)}>↑</button>
      <button type="button" aria-label="Next" disabled={matches.length === 0} onClick={() => moveMatch(1)}>↓</button>
      <button type="button" onClick={() => { refreshRuns(); if (valid) { refreshDetail(); refreshChanges(); } }}>Refresh</button>
    </div>
    <JobText key={`prompt:${job}`} job={job} kind="prompt" enabled={active && valid} />
    <JobText key={`notes:${job}`} job={job} kind="notes" enabled={active && valid} />
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
        <div ref={logRef} className={styles.log} role="log" aria-live="polite">{truncated && <>… earlier lines not shown{'\n'}</>}{lines.map((line, index) => <div key={index} className={matchedLines.has(index) ? styles.match : undefined} aria-current={current === index ? 'true' : undefined}>{line}{index < lines.length - 1 && '\n'}</div>)}</div>}
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

function JobText({ job, kind, enabled }: { job: string; kind: 'notes' | 'prompt'; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const query = useMemo(() => jobTextQuery(job, kind), [job, kind]);
  const result = useQuery(query, { enabled: enabled && open });
  const refresh = useRefresh(query);
  const data = result.data;
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{kind === 'prompt' ? 'Brief (what the job asked)' : 'Notes (what the worker reported)'}</summary>
    {open && <>
      <button type="button" disabled={!enabled} onClick={refresh}>Refresh</button>
      {result.status === 'error' ? <p>Could not read</p>
        : data === null ? <p>Not in this build yet</p>
          : data?.state === 'missing' ? <p>{kind === 'notes' ? 'No notes yet' : 'No brief on disk'}</p>
            : data?.state === 'unreadable' ? <p>Could not read</p>
              : data ? <><p>{data.bytes} bytes{data.truncated ? ' · truncated' : ''}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '16rem', overflow: 'auto' }}>{data.text}</pre></>
                : <p>{enabled ? 'Reading…' : 'Select a worker'}</p>}
    </>}
  </details>;
}
