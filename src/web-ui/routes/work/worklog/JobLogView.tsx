import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { JobLogReport, JobLogRow } from '../../../../core/fleet/job-log.js';
import { formatDuration } from './worklog-lane-stats.js';
import styles from './WorklogView.module.css';
import compact from '../../../components/layout/compact-view.module.css';

const DEFAULT_HOURS = 6;
/** GET /api/log, the report `phm log --json` prints. Lane and repo are filtered by the server so the summary always matches the rows. */
function queryFor(hours: number, lane = '', repo = ''): QueryDef<JobLogReport> {
  const params = new URLSearchParams();
  if (hours !== DEFAULT_HOURS) params.set('since', `${hours}h`);
  if (lane) params.set('lane', lane);
  if (repo) params.set('repo', repo);
  const search = params.toString();
  return { key: `joblog:${search}`, fetch: signal => apiGet<JobLogReport>(search ? `/api/log?${search}` : '/api/log', signal) };
}
const tally = (values: (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value ?? 'unknown', (counts.get(value ?? 'unknown') ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
};

function Row({ job }: { job: JobLogRow }) {
  return <li className={styles.row}>
    <div className={styles.line}>
      <time dateTime={job.at} title={job.at}>{new Date(job.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
      <span className={styles.kind} data-kind={job.result === 'failed' ? 'incident' : job.result}>{job.text}{job.result !== 'merged' ? '' : job.mergeSeconds === null ? ', time to merge unknown' : ` in ${formatDuration(job.mergeSeconds)}`}</span>
      <span className={styles.text}>{job.goal ?? 'Goal unknown'}</span>
      <span className={styles.who}>{[job.job ?? 'unknown job', job.lane ?? 'unknown lane', job.model ?? 'unknown model', job.repo ?? 'unknown repo'].join(' · ')}</span>
    </div>
    {job.url ? <a className={styles.pr} href={job.url} target="_blank" rel="noreferrer">Open PR {job.pr}</a> : null}
  </li>;
}

export function JobLogView() {
  const [hours, setHours] = useState(DEFAULT_HOURS); const [lane, setLane] = useState(''); const [repo, setRepo] = useState('');
  // The unfiltered report names every lane and repo, so the chips stay put while one is chosen.
  const allQuery = useMemo(() => queryFor(hours), [hours]);
  const query = useMemo(() => queryFor(hours, lane, repo), [hours, lane, repo]);
  const all = useQuery(allQuery).data;
  const { data, error } = useQuery(query);
  const refreshAll = useRefetch(allQuery), refresh = useRefetch(query);
  useEffect(() => {
    const update = () => { if (!document.hidden) { refresh(); if (lane || repo) refreshAll(); } };
    const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [refresh, refreshAll, lane, repo]);
  const jobs = data?.jobs ?? [];
  const quiet = jobs.filter(job => job.result === 'no-change'), shown = jobs.filter(job => job.result !== 'no-change');
  const chips = (label: string, chosen: string, choose: (value: string) => void, values: [string, number][]) => values.length > 1 || chosen
    ? <div className={styles.chips} role="group" aria-label={label}>
      <button type="button" className={styles.chip} aria-pressed={!chosen} onClick={() => choose('')}>All {label.toLowerCase()}s</button>
      {values.map(([value, count]) => <button key={value} type="button" className={styles.chip} aria-pressed={chosen === value} onClick={() => choose(value)}>{value} {count}</button>)}
    </div> : null;
  return <main className={`${styles.view} ${compact.view}`}><h1>Log</h1>
    {error ? <p role="alert">Could not update the log. {data ? 'Showing the last available jobs. ' : ''}<button type="button" onClick={refresh}>Retry</button></p> : null}
    {!data && !error && <p>Loading log…</p>}
    {data && <>
      <p role="status"><strong>Last {hours} hours: {data.headline}</strong></p>
      {chips('Lane', lane, setLane, tally((all ?? data).jobs.map(job => job.lane)))}
      {chips('Repo', repo, setRepo, tally((all ?? data).jobs.map(job => job.repo)))}
      {data.sources?.jobs.state === 'unknown' ? <p className={styles.note}>Job results: unknown. {data.sources.jobs.reason}</p> : null}
      {data.malformedLines > 0 && <p className={styles.note}>{data.malformedLines} unreadable records skipped.</p>}
      {jobs.length === 0 ? <p className={styles.empty}>{lane || repo ? 'No jobs match these filters. ' : `No jobs recorded in the last ${hours} hours. New jobs show up here as they launch. `}
        {lane || repo ? <button type="button" onClick={() => { setLane(''); setRepo(''); }}>Show everything</button>
          : hours < 24 ? <button type="button" onClick={() => setHours(24)}>Show the last 24 hours</button> : null}</p> : null}
      {shown.length ? <ul className={styles.list} aria-label="Jobs">{shown.map(job => <Row key={`${job.job}|${job.at}|${job.url}`} job={job} />)}</ul> : null}
      {quiet.length ? <details className={styles.more}><summary>{quiet.length} {quiet.length === 1 ? 'job' : 'jobs'} made no change</summary>
        <ul className={styles.list} aria-label="Jobs that made no change">{quiet.map(job => <Row key={`${job.job}|${job.at}`} job={job} />)}</ul></details> : null}
    </>}
  </main>;
}
