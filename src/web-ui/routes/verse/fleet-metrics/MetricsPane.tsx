import type { MetricsPanel } from '../../../../core/fleet/metrics-panel.js';
import type { ReleasesReport } from '../../../../core/release/status.js';
import { ChartContainer } from '../../../components/charts/ChartContainer.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { JobYieldCard } from './JobYieldCard.js';
import { LeverageTile } from './LeverageTile.js';
import { MetricsGlance } from './MetricsGlance.js';
import { ReleasesCard } from './ReleasesCard.js';

const query: QueryDef<MetricsPanel> = { key: 'fleet-metrics-panel', fetch: signal => apiGet('/api/verse/fleet/runs/metrics', signal) };
const releasesQuery: QueryDef<ReleasesReport> = { key: 'fleet-releases', fetch: signal => apiGet('/api/fleet/releases', signal) };
export function MetricsPane({ visible }: PaneProps) {
  // Tags move slowly, so this is read when the pane opens and kept for five minutes.
  const releases = useQuery(releasesQuery, { enabled: visible, freshMs: 300_000 });
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const data = read.data;
  const history = data?.series;
  const hours = history?.hours ?? [];
  const repos = [...new Set(hours.flatMap(hour => Object.keys(hour.byRepo)))].sort();
  const mergeSeries = repos.length ? repos.map(repo => ({ id: repo, label: repo,
    points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.merged === null ? null : hour.byRepo[repo] ?? 0 })) })) :
    [{ id: 'all', label: 'All repos', points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.merged })) }];
  const hourLabel = (stamp: string) => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const capacity = Object.fromEntries((data?.lanes ?? []).map(row => [row.lane, `${row.running ?? 'unknown'} / ${row.target ?? 'unknown'}`]));
  return <section aria-label="Metrics"><h2>Metrics</h2>
    {!data ? <p>{read.status === 'error' ? 'Metrics are unknown.' : 'Reading metrics…'}</p> : null}
    <MetricsGlance report={data?.glance} capacity={capacity} />
    <LeverageTile report={data?.leverage} />
    <JobYieldCard report={data?.jobYield} stopped={data?.stopped} />
    <ReleasesCard report={releases.data} />
    <p>Merged PRs: {history?.mergesLastHour ?? 'unknown'} in the last hour · {history?.mergesLast24h ?? 'unknown'} in the last 24 hours.</p>
    <p>Updated: {history?.observedAt ? hourLabel(history.observedAt) : 'unknown'}.</p>
    {history?.known && history.malformedLines > 0 ? <p>Merge history skipped {history.malformedLines} malformed lines.</p> : null}
    <ChartContainer title="Merged PRs per hour" description="Last 24 hours, by repo. Each point starts a one-hour interval."
      empty={!history?.known} emptyMessage="Merge history: unknown (job metrics file unreadable)."
      table={history?.known ? <table><caption>Merged PRs by hour and repo</caption><thead><tr><th>Hour starting</th><th>All repos</th>{repos.map(repo => <th key={repo}>{repo}</th>)}</tr></thead>
        <tbody>{hours.map(hour => <tr key={hour.start}><td>{hourLabel(hour.start)}</td><td>{hour.merged}</td>{repos.map(repo => <td key={repo}>{hour.byRepo[repo] ?? 0}</td>)}</tr>)}</tbody></table> : undefined}>
      <LineChart series={mergeSeries} height={160} ariaLabel="Merged PRs per hour by repo" />
    </ChartContainer>
    <ChartContainer title="Merged PRs per launch" description="Merges divided by launches in each hour. Human actions are not recorded, so this does not measure autonomy."
      caveat="Merges may come from earlier launches. Gaps mean no launches in that hour."
      empty={!history?.known} emptyMessage="Launch and merge history: unknown (job metrics file unreadable)."
      table={history?.known ? <table><caption>Merged PRs per launch by hour</caption><thead><tr><th>Hour starting</th><th>Merged</th><th>Launches</th><th>PRs per launch</th></tr></thead>
        <tbody>{hours.map(hour => <tr key={hour.start}><td>{hourLabel(hour.start)}</td><td>{hour.merged}</td><td>{hour.launches}</td><td>{hour.mergesPerLaunch === null ? 'No launches' : hour.mergesPerLaunch.toFixed(2)}</td></tr>)}</tbody></table> : undefined}>
      <LineChart series={[{ id: 'yield', label: 'PRs per launch', points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.mergesPerLaunch })) }]}
        height={160} formatY={value => value.toFixed(2)} ariaLabel="Merged PRs per launch by hour" />
    </ChartContainer>
    <h3>Jobs by generator</h3>
    <p>Last 24 hours. Empty rate uses jobs with a recorded empty result. Tokens per merged PR includes all jobs in the group.</p>
    {!data?.generatorYield?.known ? <p>Generator measurements: unknown</p> : <>
      <p>Malformed lines skipped: {data.generatorYield.malformedLines}</p>
      <table><thead><tr><th>Generator</th><th>Jobs</th><th>PRs</th><th>Merged</th><th>Empty rate</th><th>Median diff lines</th><th>Tokens per merged PR</th></tr></thead>
        <tbody>{data.generatorYield.generators.map(row => <tr key={row.generator}><td>{row.generator}</td><td>{row.jobs}</td><td>{row.prs}</td><td>{row.merged}</td><td>{row.emptyRate === null ? 'unknown' : `${(row.emptyRate * 100).toFixed(1)}%`}</td><td>{row.medianDiffLines ?? 'unknown'}</td><td>{row.tokensPerMergedPr ?? 'unknown'}</td></tr>)}</tbody></table>
    </>}
  </section>;
}
