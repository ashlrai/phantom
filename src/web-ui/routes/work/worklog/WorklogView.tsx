import { useEffect, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatDuration, laneStats } from './worklog-lane-stats.js';
import type { WorklogEntry, WorklogReport } from '../../../../core/fleet/worklog.js';
import compact from '../../../components/layout/compact-view.module.css';

const query: QueryDef<WorklogReport> = { key: 'worklog', fetch: signal => apiGet<WorklogReport>('/api/worklog', signal) };
const labels: Record<WorklogEntry['kind'], string> = { launch: 'Launched', finished: 'Finished', pr: 'PR opened', empty: 'Empty', failed: 'Failed', merged: 'Merged' };
export function WorklogView() {
  const { data, error } = useQuery(query);
  const refresh = useRefetch(query);
  useEffect(() => {
    const update = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(update, 5000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);
  const [repo, setRepo] = useState(''); const [lane, setLane] = useState('');
  const entries = data?.entries ?? [];
  const visible = entries.filter(e => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane));
  const choices = (values: (string | null)[]) => [...new Set(values.map(v => v ?? 'unknown'))].sort();
  return <main className={compact.view}><h1>Work log</h1><p>Job launches, finishes and merges from the last 24 hours, newest first. Updates every 5 seconds.</p>
    {error ? <p role="alert">Could not update the work log. {data ? 'Showing the last available events. ' : ''}<button type="button" onClick={refresh}>Retry</button></p> : null}
    {!data && !error && <p>Loading work log…</p>}
    {data && <><label>Repo <select value={repo} onChange={e => setRepo(e.target.value)}><option value="">All repos</option>{choices(entries.map(e => e.repo)).map(v => <option key={v}>{v}</option>)}</select></label>{' '}
      <label>Lane <select value={lane} onChange={e => setLane(e.target.value)}><option value="">All lanes</option>{choices(entries.map(e => e.lane)).map(v => <option key={v}>{v}</option>)}</select></label>
      {data.malformedLines > 0 && <p>{data.malformedLines} unreadable records skipped.</p>}
      {visible.length === 0 ? <p>{entries.length ? 'No work events match these filters.' : 'No work events in the last 24 hours. New events will appear here.'}</p> :
      <div style={{ overflowX: 'auto' }}><table aria-label="Work events"><thead><tr><th>Time</th><th>Result</th><th>Repo</th><th>Job</th><th>Lane</th><th>Model</th><th>Pull request</th></tr></thead><tbody>
        {visible.map((e, i) => <tr key={`${e.job}-${e.at}-${e.kind}-${i}`}><td data-label="Time"><time dateTime={e.at} title={e.at}>{new Date(e.at).toLocaleString()}</time></td><td data-label="Result">{labels[e.kind]}</td><td data-label="Repo">{e.repo ?? 'unknown'}</td><td data-label="Job">{e.job ?? 'unknown'}</td><td data-label="Lane">{e.lane ?? 'unknown'}</td><td data-label="Model">{e.model ?? 'unknown'}</td><td data-label="Pull request">{e.url ? <a href={e.url}>Open PR</a> : '—'}</td></tr>)}
      </tbody></table></div>}
      <h2>By lane</h2>
      <table><thead><tr><th>Lane</th><th>Merged</th><th>Median open to merge</th><th>Unknown timing</th><th>Top model</th></tr></thead><tbody>
        {laneStats(visible).map(row => <tr key={row.lane}><td data-label="Lane"><button type="button" onClick={() => setLane(row.lane)}>{row.lane}</button></td><td data-label="Merged">{row.count}</td><td data-label="Median open to merge">{formatDuration(row.medianSeconds)}</td><td data-label="Unknown timing">{row.unknownTiming}</td><td data-label="Top model">{row.topModel ?? 'unknown'}</td></tr>)}
      </tbody></table>
      </>}
  </main>;
}
