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
    <h3>Jobs by generator</h3>
    <p>Last 24 hours. Empty rate uses jobs with a recorded empty result. Tokens per merged PR includes all jobs in the group.</p>
    {!data?.generatorYield?.known ? <p>Generator measurements: unknown</p> : <>
      <p>Malformed lines skipped: {data.generatorYield.malformedLines}</p>
      <table><thead><tr><th>Generator</th><th>Jobs</th><th>PRs</th><th>Merged</th><th>Empty rate</th><th>Median diff lines</th><th>Tokens per merged PR</th></tr></thead>
        <tbody>{data.generatorYield.generators.map(row => <tr key={row.generator}><td>{row.generator}</td><td>{row.jobs}</td><td>{row.prs}</td><td>{row.merged}</td><td>{row.emptyRate === null ? 'unknown' : `${(row.emptyRate * 100).toFixed(1)}%`}</td><td>{row.medianDiffLines ?? 'unknown'}</td><td>{row.tokensPerMergedPr ?? 'unknown'}</td></tr>)}</tbody></table>
    </>}
  </section>;
}
