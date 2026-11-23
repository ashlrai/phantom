import { useEffect, useMemo, useRef, useState } from 'react';
import { invalidate } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { queueRecut, recutDropJobsQuery } from '../fleet-outcomes/recut-queue-client.js';
import { jobBacklogQuery } from './job-backlog-query.js';
import { backlogVerdict, parseLogPr, recutFromLog } from './log-recut-model.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { steerPrefill } from '../fleet/job-sheet-actions.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { describeJob } from '../../../../core/fleet/job-tail-words.js';
import { JOB_ID_RE, jobOptions, pollMs, publishFacts, safePrUrl, sessionFacts, stateTone, stepJob, stepLabel } from './worker-log-model.js';
import { jobDetailQuery } from './worker-log-queries.js';
import { workerLogMarkdown } from './worker-log-markdown.js';
import { takeRequestedWorkerLogJob, useRequestedWorkerLogJob } from './worker-log-selection.js';
import { jobChangesQuery } from './worker-changes-queries.js';
import { changesHeadline, sortFiles } from './worker-changes-model.js';
import { findMatches, matchLabel, nextMatch } from './log-find-model.js';
import { jobTextQuery } from './job-text-queries.js';
import { jobStopEligible } from './job-stop-action.js';
import { JobControls } from './JobControls.js';
import { JobNoteBox } from './JobNoteBox.js';
import { livenessText, livenessTone, newLinesLabel, trackGrowth, type TrackedLog } from './log-liveness-model.js';
import { JobActivity } from './JobActivity.js';
import { JobWindowCard } from './JobWindowCard.js';
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
  const tracked = useRef<{ job: string; value: TrackedLog | null }>({ job, value: null });
  const [liveness, setLiveness] = useState<TrackedLog | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (tracked.current.job !== job) tracked.current = { job, value: null };
    if (!detail.data) { setLiveness(null); return; }
    const value = trackGrowth(tracked.current.value, { ...detail.data, follow }, Date.now());
    tracked.current.value = value;
    setLiveness(value);
  }, [job, detail.data, follow]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const clearUnseen = () => {
    if (!tracked.current.value?.unseenLines) return;
    tracked.current.value = { ...tracked.current.value, unseenLines: 0 };
    setLiveness(tracked.current.value);
  };
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
  const pr = parseLogPr(url);
  const backlogQuery = useMemo(() => jobBacklogQuery(pr?.repo ?? ''), [pr?.repo]);
  const backlog = useQuery(backlogQuery, { enabled: active && pr !== null, freshMs: 60_000 });
  const verdict = backlog.status === 'error' ? null : backlogVerdict(url, backlog.data, now);
  const backlogUnavailable = pr !== null && (backlog.data === null || backlog.data?.source === 'gh-failed' || backlog.status === 'error');
  const { testLine, sensitive } = publishFacts(detail.data?.publish);
  // The detail does not carry the repo; the running-worker row does, and so does a published PR link.
  const facts = detail.data ? sessionFacts(detail.data, runs.data?.workers.find(worker => worker.job === job)?.repo ?? pr?.repo, now) : [];
  const step = (dir: 1 | -1) => { const next = stepJob(options, job, dir); if (next !== null) setSelection(next); };
  const canStep = stepJob(options, job, 1) !== null;
  // Same plain words as `phm job tail` (core/fleet/job-tail-words.ts).
  const words = detail.data ? describeJob({ ...detail.data, job: detail.data.job ?? job }, Date.now()) : null;
  const state = detail.data?.state ?? 'unknown';

  // [ and ] walk the running sessions from anywhere in the pane except a field, where they are typing.
  return <div className={styles.pane} aria-label="Worker log" tabIndex={-1} onKeyDown={event => {
    if ((event.key !== '[' && event.key !== ']') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || (event.target as HTMLElement).closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return;
    event.preventDefault(); step(event.key === ']' ? 1 : -1);
  }}>
    <div className={styles.controls}>
      <label>Worker <select aria-label="Worker" value={valid ? job : ''} onChange={event => setSelection(event.target.value)}>
        {!valid && <option value="">Select a worker</option>}
        {retained && <option value={job}>{job}</option>}
        {options.map(option => <option key={option.job} value={option.job}>{option.label}</option>)}
      </select></label>
      <span className={styles.step} role="group" aria-label="Step through sessions">
        <button type="button" aria-label="Previous session" title="Previous session ([)" aria-keyshortcuts="[" disabled={!canStep} onClick={() => step(-1)}>‹</button>
        {valid && <span>{stepLabel(options, job)}</span>}
        <button type="button" aria-label="Next session" title="Next session (])" aria-keyshortcuts="]" disabled={!canStep} onClick={() => step(1)}>›</button>
      </span>
      <label>Job ID <input aria-label="Job ID" value={job} onChange={event => setSelection(event.target.value)} aria-invalid={job !== '' && !valid} aria-describedby={job !== '' && !valid ? 'worker-log-id-hint' : undefined} /></label>
      <label className={styles.follow}><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> Follow</label>
      <label>Find in log <input type="search" aria-label="Find in log" value={search} onChange={event => { setSearch(event.target.value); setSelectedMatch(null); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { setSearch(''); setSelectedMatch(null); }
      }} /></label>
      <Button size="sm" variant="subtle" aria-label="Copy as Markdown" disabled={!valid || !detail.data} onClick={() => void copy()}>Copy as Markdown</Button><span role="status">{notice}</span>
      <Button size="sm" variant="subtle" aria-label="Steer this job" disabled={!valid} onClick={() => openInterjectDialog({ prefill: steerPrefill(job, detail.data?.lane ?? runs.data?.workers.find(worker => worker.job === job)?.lane) })}>Steer</Button>
      {valid && jobStopEligible(state) && <JobControls job={job} lane={detail.data?.lane} onDone={() => { refreshRuns(); refreshDetail(); }} />}
      {verdict && <LogRecut key={`${job}:${url}`} job={job} prUrl={url} lane={detail.data?.lane} verdict={verdict} />}
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
    {valid && <JobActivity job={job} enabled={active} pollMs={pollMs(detail.data)} />}
    {valid && detail.data === null && <p>The job detail API has not landed in this build yet.</p>}
    {valid && detail.status === 'error' && <p role="status">Job detail could not refresh.</p>}
    {valid && <JobWindowCard job={job} detail={detail.data} enabled={active} pollMs={pollMs(detail.data)} />}
    {valid && <JobNoteBox job={job} open={jobStopEligible(state)} enabled={active} />}
    {valid && detail.data && <>
      <section className={styles.session} aria-label="Session">
        <div className={styles.sessionTop}>
          <h3 className={styles.sessionId}>{job}</h3>
          <StatusBadge status={state} tone={stateTone(state)}>{state}</StatusBadge>
          <StatusBadge status="output" tone={livenessTone(liveness?.lastGrowthAt ?? null, state, now)}>{livenessText(liveness?.lastGrowthAt ?? null, state, now)}</StatusBadge>
        </div>
        <dl className={styles.facts}>{facts.map(fact => <div key={fact.label}>
          <dt>{fact.label}</dt>
          {fact.value === null ? <dd data-unknown>{fact.missing}</dd>
            : <dd>{fact.href ? <a href={fact.href} target="_blank" rel="noreferrer">{fact.value}</a> : fact.at ? <time dateTime={fact.at} title={new Date(fact.at).toLocaleString()}>{fact.value}</time> : fact.value}</dd>}
        </div>)}</dl>
      </section>
      {backlogUnavailable && <p role="status">merge backlog unavailable</p>}
      {verdict && <p className={styles.meta}>{verdict.text}</p>}
      {(testLine !== null || sensitive !== null) && <section aria-label="Publish" className={styles.meta}>
        {testLine !== null && <p>Tests: <code>{testLine}</code></p>}
        {sensitive !== null && <p role="note">Touches owner-reviewed paths: {sensitive.join(', ')}</p>}
      </section>}
      {words?.text && <p className={styles.hint}>{words.text}</p>}
      {words?.showLog &&
        <div className={styles.logWrap}>
          <div ref={logRef} className={styles.log} role="log" aria-live="polite" onScroll={event => {
            const log = event.currentTarget;
            if (log.scrollTop + log.clientHeight >= log.scrollHeight - 1) clearUnseen();
          }}>{truncated && <>… earlier lines not shown{'\n'}</>}{lines.map((line, index) => <div key={index} className={matchedLines.has(index) ? styles.match : undefined} aria-current={current === index ? 'true' : undefined}>{line}{index < lines.length - 1 && '\n'}</div>)}</div>
          {!follow && <button type="button" className={styles.newLines} onClick={() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
            clearUnseen(); setFollow(true);
          }}>{(liveness?.unseenLines ?? 0) > 0 ? newLinesLabel(liveness?.unseenLines ?? 0) : 'Jump to latest'} ↓</button>}
        </div>}
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

function LogRecut({ job, prUrl, lane, verdict }: { job: string; prUrl: string | null; lane: string | null | undefined; verdict: NonNullable<ReturnType<typeof backlogVerdict>> }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const queued = useRef(false);
  async function queue() {
    const recut = recutFromLog({ job, prUrl, title: null, lane, nowMs: Date.now() });
    if (!recut || inFlight.current || queued.current || !(verdict.action === 'recut' || verdict.mergeStateStatus === 'DIRTY')) return;
    inFlight.current = true;
    setBusy(true);
    setResult('');
    try {
      const outcome = await queueRecut(recut);
      if (outcome === 'queued') {
        queued.current = true;
        setResult(`Queued as RQ-PHX-${recut.id}`);
        invalidate(recutDropJobsQuery.key);
      } else if (outcome === 'already queued') {
        queued.current = true;
        setResult('Already queued');
      } else setResult('Recut unavailable (drop-jobs route missing)');
    } catch (error) { setResult(readFailureReason(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <><Button size="sm" variant="subtle" aria-label={`Recut PR ${verdict.number}`} disabled={busy || queued.current || !(verdict.action === 'recut' || verdict.mergeStateStatus === 'DIRTY')} onClick={() => void queue()}>Recut PR #{verdict.number}</Button><span role="status">{result}</span></>;
}
