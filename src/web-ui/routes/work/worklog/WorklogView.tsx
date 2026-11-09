import { useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { WorklogReport } from '../../../../core/fleet/worklog.js';

const query: QueryDef<WorklogReport> = { key: 'worklog', fetch: signal => apiGet<WorklogReport>('/api/worklog', signal) };
export function WorklogView() {
  const { data, error } = useQuery(query);
  const [repo, setRepo] = useState(''); const [lane, setLane] = useState('');
  const entries = data?.entries ?? [];
  const visible = entries.filter(e => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane));
  const choices = (values: (string | null)[]) => [...new Set(values.map(v => v ?? 'unknown'))].sort();
  return <main><h1>Work log</h1><p>Merged pull requests from the last 24 hours, newest first.</p>
    {error ? <p role="alert">Could not read the work log.</p> : null}
    {!data && !error && <p>Loading work log…</p>}
    {data && <><label>Repo <select value={repo} onChange={e => setRepo(e.target.value)}><option value="">All repos</option>{choices(entries.map(e => e.repo)).map(v => <option key={v}>{v}</option>)}</select></label>{' '}
      <label>Lane <select value={lane} onChange={e => setLane(e.target.value)}><option value="">All lanes</option>{choices(entries.map(e => e.lane)).map(v => <option key={v}>{v}</option>)}</select></label>
      <p>{data.malformedLines} malformed lines skipped.</p>
      {visible.length === 0 && <p>No merged pull requests match these filters.</p>}
      <table><thead><tr><th>Merged</th><th>Repo</th><th>Job</th><th>Lane</th><th>Model</th><th>Open to merge (seconds)</th><th>Pull request</th></tr></thead><tbody>
        {visible.map((e, i) => <tr key={`${e.job}-${e.mergedAt}-${i}`}><td>{e.mergedAt}</td><td>{e.repo ?? 'unknown'}</td><td>{e.job ?? 'unknown'}</td><td>{e.lane ?? 'unknown'}</td><td>{e.model ?? 'unknown'}</td><td>{e.openToMergeSeconds ?? 'unknown'}</td><td>{e.url ? <a href={e.url}>Open PR</a> : 'unknown'}</td></tr>)}
      </tbody></table></>}
  </main>;
}
