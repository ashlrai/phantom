import { useEffect } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { ResourceView } from '../../../../core/fabric/resource-view.js';
import type { MergePaceReport } from '../../../../core/fleet/merge-pace.js';
import { projectLiveStatus } from '../../../../core/fleet/live-status.js';

type LiveHome = ReturnType<typeof projectLiveStatus> & { mergePace?: MergePaceReport | null };
const mergeMinutes = (s: number | null) => s === null ? 'unknown' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

const query: QueryDef<LiveHome> = {
  key: 'verse-live-home',
  fetch: async signal => {
    const [live, resources, mergePace] = await Promise.all([
      apiGet<FleetLiveSnapshotV1>('/api/verse/fleet/live', signal),
      apiGet<ResourceView>('/api/resource', signal),
      // A merge-pace failure is unknown, never a blank view.
      apiGet<MergePaceReport>('/api/verse/fleet/merge-pace', signal).catch(() => null),
    ]);
    return { ...projectLiveStatus(live, resources), mergePace };
  },
};
export function LiveStatusSection() {
  const result = useQuery(query);
  const refresh = useRefetch(query);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const data = result.data;
  return <section aria-label="Live fleet" style={{ padding: 24, overflow: 'auto' }}>
    <h1>Live fleet</h1>
    <button onClick={refresh}>Refresh</button>
    {result.status === 'error' && <p role="alert">Live status unavailable. Retry with Refresh. Previous readings may be stale.</p>}
    {!data ? <p role="status">Loading live status…</p> : <>
      <p>{data.state} · {data.reason} · Updated <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString()}</time></p>
      <h2>Running</h2>
      {data.running === null ? <p>Unknown</p> : <ul>{data.running.map(run => <li key={run.id}>{run.repo}: {run.title} · {run.phase}</li>)}{!data.running.length && <li>None</li>}</ul>}
      <h2>Merged (24h)</h2>
      {data.merged === null ? <p>Unknown</p> : <ul>{data.merged.map(row => <li key={row.id}>{row.repo} #{row.prNumber} · {new Date(row.landedAt).toLocaleString()}</li>)}{!data.merged.length && <li>None</li>}</ul>}
      <h2>Merge pace (6h)</h2>
      {data.mergePace === undefined ? null : !data.mergePace?.known || !data.mergePace.rows ? <p>Unknown</p> : <ul>{data.mergePace.rows.map(row => <li key={row.repo}>{row.repo}: {row.merges} merges · {row.merges_per_hour.toFixed(1)}/h · median {mergeMinutes(row.median_ttm_s)}</li>)}</ul>}
      <h2>Blocked</h2>
      {data.blocked === null ? <p>Unknown</p> : <ul>{data.blocked.map((row, index) => <li key={index}>{row.repo}: {row.reason} · Until {row.until ?? 'cleared'}</li>)}{!data.blocked.length && <li>None recorded</li>}</ul>}
      <h2>Spent</h2>
      <ul>{data.spent.map(row => <li key={row.pool}>{row.pool}: {row.pctUsed === null ? 'unknown' : `${row.pctUsed}% used`} · Reset {row.resetAt ? new Date(row.resetAt).toLocaleString() : 'unknown'}</li>)}</ul>
    </>}
  </section>;
}
