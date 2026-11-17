import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { jobDetailQuery } from '../../verse/fleet-job-log/worker-log-queries.js';
import { JOB_ID_RE } from '../../verse/fleet-job-log/job-id.js';
import { formatDuration, laneStats } from './worklog-lane-stats.js';
import type { WorklogKind, WorklogReport, WorklogRow } from '../../../../core/fleet/worklog.js';
import styles from './WorklogView.module.css';
import compact from '../../../components/layout/compact-view.module.css';
import { EmptyJobsPanel } from '../../verse/growth/EmptyJobsPanel.js';

const KINDS: Record<WorklogKind, string> = { merged: 'Merged', launched: 'Launched', finished: 'Finished', empty: 'No change', leader: 'Leader', incident: 'Incidents' };
const SOURCES: Record<keyof WorklogReport['sources'], string> = { jobs: 'Job results', events: 'Dispatch events', leader: 'Leader replies' };
const DEFAULT_HOURS = 6;
// The server default is 6 hours, the same window `phm worklog` reads.
const queryFor = (hours: number): QueryDef<WorklogReport> => ({
  key: hours === DEFAULT_HOURS ? 'worklog' : `worklog:${hours}`,
  fetch: signal => apiGet<WorklogReport>(hours === DEFAULT_HOURS ? '/api/worklog' : `/api/worklog?hours=${hours}`, signal),
});

/** Rows arrive newest first, so each change of local hour starts a group. */
function byHour(rows: WorklogRow[]): { label: string; rows: WorklogRow[] }[] {
  const groups: { label: string; rows: WorklogRow[] }[] = [];
  for (const row of rows) {
    const label = new Date(row.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
    if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
    groups.at(-1)!.rows.push(row);
  }
  return groups;
}

function JobDetail({ job }: { job: string }) {
  const query = useMemo(() => jobDetailQuery(job), [job]);
  const { data, status } = useQuery(query, { freshMs: 0 });
  if (status === 'error') return <p role="alert" className={styles.detail}>Job detail could not be loaded.</p>;
  if (data === undefined) return <p className={styles.detail}>Loading job detail…</p>;
  if (data === null) return <p className={styles.detail}>No detail is recorded for this job.</p>;
  const tail = data.log?.tail ?? [];
  return <section className={styles.detail} aria-label={`Job detail for ${job}`}>
    <p>State: {data.state ?? 'unknown'} · Lane: {data.lane ?? 'unknown'} · Model: {data.model ?? 'unknown'}</p>
    <p>Branch: {data.branch ?? 'unknown'} · Launched: {data.launchedAt ? new Date(data.launchedAt).toLocaleString() : 'unknown'}</p>
    {data.publish?.testLine ? <p>Tests: {data.publish.testLine}</p> : null}
    {tail.length ? <pre>{tail.slice(-8).join('\n')}</pre> : <p>No log lines are recorded.</p>}
  </section>;
}

function Row({ row }: { row: WorklogRow }) {
  const [open, setOpen] = useState(false);
  const canOpen = row.job !== null && JOB_ID_RE.test(row.job);
  // Job rows say what is unknown; leader and incident rows have no job, lane or repo to miss.
  const ledger = row.kind !== 'leader' && row.kind !== 'incident';
  const who = [row.job ?? (ledger ? 'unknown job' : null), row.lane ?? (ledger ? 'unknown lane' : null), row.repo ?? (ledger ? 'unknown repo' : null)].filter(Boolean).join(' · ');
  const line = <>
    <time dateTime={row.at} title={row.at}>{new Date(row.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
    <span className={styles.kind} data-kind={row.kind}>{KINDS[row.kind]}</span>
    <span className={styles.text}>{row.text}{row.count > 1 ? ` (${row.count} events)` : ''}</span>
    {who ? <span className={styles.who}>{who}</span> : null}
  </>;
  return <li className={styles.row}>
    {canOpen ? <button type="button" className={styles.line} aria-expanded={open} onClick={() => setOpen(!open)}>{line}</button> : <div className={styles.line}>{line}</div>}
    {row.url ? <a className={styles.pr} href={row.url} target="_blank" rel="noreferrer">Open PR #{row.url.split('/').pop()}</a> : null}
    {open && canOpen ? <JobDetail job={row.job!} /> : null}
  </li>;
}

export function WorklogView() {
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const query = useMemo(() => queryFor(hours), [hours]);
  const { data, error } = useQuery(query);
  const refresh = useRefetch(query);
  useEffect(() => {
    const update = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(update, 5000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  const [kind, setKind] = useState<WorklogKind | ''>(''); const [repo, setRepo] = useState(''); const [lane, setLane] = useState('');
  // An older server sends no rows or sources; show what it does send instead of failing.
  const rows = data?.rows ?? []; const entries = data?.entries ?? [];
  const match = (e: { repo: string | null; lane: string | null }) => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane);
  const scoped = rows.filter(match);
  const visible = scoped.filter(row => !kind || row.kind === kind);
  const choices = (values: (string | null)[]) => [...new Set(values.map(v => v ?? 'unknown'))].sort();
  const chip = (value: WorklogKind | '', label: string, count: number) => <button key={value} type="button" className={styles.chip} aria-pressed={kind === value} onClick={() => setKind(value)}>{label} {count}</button>;
  return <main className={`${styles.view} ${compact.view}`}><h1>Work log</h1><p>What the fleet did in the last {hours} hours, newest first. Tap a job to see its detail.</p>
    {error ? <p role="alert">Could not update the work log. {data ? 'Showing the last available events. ' : ''}<button type="button" onClick={refresh}>Retry</button></p> : null}
    {!data && !error && <p>Loading work log…</p>}
    {data && <>
      <div className={styles.chips} role="group" aria-label="Show">
        {chip('', 'All', scoped.length)}
        {(Object.keys(KINDS) as WorklogKind[]).map(k => chip(k, KINDS[k], scoped.filter(row => row.kind === k).length))}
      </div>
      {Object.entries(data.sources ?? {}).map(([name, source]) => source.state === 'unknown'
        ? <p key={name} role="status" className={styles.note}>{SOURCES[name as keyof WorklogReport['sources']]}: unknown. {source.reason}</p> : null)}
      {data.malformedLines > 0 && <p className={styles.note}>{data.malformedLines} unreadable records skipped.</p>}
      {visible.length === 0 ? <p className={styles.empty}>{rows.length ? 'Nothing matches these filters. ' : `Nothing recorded in the last ${hours} hours. New work shows up here as it happens. `}
        {kind || repo || lane ? <button type="button" onClick={() => { setKind(''); setRepo(''); setLane(''); }}>Show everything</button>
          : hours < 24 ? <button type="button" onClick={() => setHours(24)}>Show the last 24 hours</button> : null}</p>
        : byHour(visible).map(group => <section key={group.label} aria-label={group.label}><h2 className={styles.hour}>{group.label}</h2>
          <ul className={styles.list}>{group.rows.map(row => <Row key={`${row.at}|${row.kind}|${row.job}|${row.text}`} row={row} />)}</ul></section>)}
      <details className={styles.more}><summary>Repo and lane filters, merge times by lane</summary>
        <label>Repo <select value={repo} onChange={e => setRepo(e.target.value)}><option value="">All repos</option>{choices([...rows, ...entries].map(e => e.repo)).map(v => <option key={v}>{v}</option>)}</select></label>{' '}
        <label>Lane <select value={lane} onChange={e => setLane(e.target.value)}><option value="">All lanes</option>{choices([...rows, ...entries].map(e => e.lane)).map(v => <option key={v}>{v}</option>)}</select></label>
        <h2>By lane</h2>
        <table><thead><tr><th>Lane</th><th>Merged</th><th>Median open to merge</th><th>Unknown timing</th><th>Top model</th></tr></thead><tbody>
          {laneStats(entries.filter(match)).map(row => <tr key={row.lane}><td data-label="Lane"><button type="button" onClick={() => setLane(row.lane)}>{row.lane}</button></td><td data-label="Merged">{row.count}</td><td data-label="Median open to merge">{formatDuration(row.medianSeconds)}</td><td data-label="Unknown timing">{row.unknownTiming}</td><td data-label="Top model">{row.topModel ?? 'unknown'}</td></tr>)}
        </tbody></table>
      </details>
    </>}
    <EmptyJobsPanel />
  </main>;
}
