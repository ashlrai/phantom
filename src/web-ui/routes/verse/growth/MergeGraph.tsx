import { useState } from 'react';
import { AreaTrend } from '../../../components/charts/AreaTrend.js';
import { CHART_SEQUENTIAL } from '../../../components/charts/colors.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { MergeGraphReport } from '../../../../core/fleet/merge-graph.js';

const query = { key: 'metrics-merges', fetch: (signal?: AbortSignal) => apiGet<MergeGraphReport>('/api/verse/metrics/merges', signal) };
export function MergeGraph() {
  const { data, status } = useQuery(query, { freshMs: 5_000 });
  const [selected, setSelected] = useState('');
  const lanes = data?.schema === 'metrics.merges.v1' && data.known ? data.lanes : null;
  const lane = lanes?.find(item => item.lane === selected) ?? lanes?.[0];
  const chartStatus = status === 'idle' || status === 'loading' ? { kind: 'loading' as const }
    : !lanes || status === 'error' ? { kind: 'unknown' as const, reason: 'Merge data is unknown.' }
      : !lane ? { kind: 'unknown' as const, reason: 'No merges in the last 24 hours.' } : { kind: 'ready' as const };
  return <section aria-label="Merges by lane">
    <h2>Merges by lane · last 24 hours</h2>
    <p>Hourly counts and median time from opening to merge. The current hour is partial; missing times are unknown.</p>
    {lanes && lanes.length > 0 ? <label>Lane <select value={lane?.lane} onChange={event => setSelected(event.target.value)}>{lanes.map(item => <option key={item.lane} value={item.lane}>{item.lane}</option>)}</select></label> : null}
    <AreaTrend title="PRs merged per hour" status={chartStatus} height={180} series={[{ id: 'merges', label: 'Merges', color: CHART_SEQUENTIAL, points: lane?.buckets.map(bucket => ({ x: Date.parse(bucket.start), y: bucket.merges })) ?? [] }]} />
    <AreaTrend title="Median open-to-merge time (minutes)" status={chartStatus} height={180} series={[{ id: 'median', label: 'Minutes', color: CHART_SEQUENTIAL, points: lane?.buckets.map(bucket => ({ x: Date.parse(bucket.start), y: bucket.medianSeconds === null ? null : bucket.medianSeconds / 60 })) ?? [] }]} />
    {lane ? <details><summary>Hourly values</summary><table><thead><tr><th>Hour (UTC)</th><th>Merges</th><th>Median minutes</th></tr></thead><tbody>{lane.buckets.map(bucket => <tr key={bucket.start}><td>{bucket.start}</td><td>{bucket.merges}</td><td>{bucket.medianSeconds === null ? 'unknown' : (bucket.medianSeconds / 60).toFixed(1)}</td></tr>)}</tbody></table></details> : null}
  </section>;
}
