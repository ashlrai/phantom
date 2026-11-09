import type { MetricsPanel } from '../../../../core/fleet/metrics-panel.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<MetricsPanel> = { key: 'fleet-metrics-panel', fetch: signal => apiGet('/api/verse/fleet/runs/metrics', signal) };
export function MetricsPane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const data = read.data;
  return <section aria-label="Metrics"><h2>Metrics</h2>
    <p>Jobs launched in the last 24 hours. Updated: {data?.observedAt ?? 'unknown'}.</p>
    <p>Hourly merges over 24 hours: unknown</p>
    {!data ? <p>{read.status === 'error' ? 'Metrics are unknown.' : 'Reading metrics…'}</p> : data.lanes.length === 0 ? <p>Lane measurements: unknown</p> :
      <table><thead><tr><th>Lane</th><th>PRs merged per hour</th><th>Median open to merge (seconds)</th><th>Empty rate</th><th>Running / target</th></tr></thead>
        <tbody>{data.lanes.map(row => <tr key={row.lane}><td>{row.lane}</td><td>{row.mergesPerHour === null ? 'unknown' : row.mergesPerHour.toFixed(2)}</td><td>{row.medianOpenToMergeSeconds ?? 'unknown'}</td><td>{row.emptyRate === null ? 'unknown' : `${(row.emptyRate * 100).toFixed(1)}%`}</td><td>{row.running ?? 'unknown'} / {row.target ?? 'unknown'}</td></tr>)}</tbody></table>}
  </section>;
}
