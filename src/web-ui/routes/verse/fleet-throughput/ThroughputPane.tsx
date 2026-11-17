/** Throughput pane: the `phm throughput` report as a headline, two hourly lines and one bar per lane. */
import type { ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { BarChart } from '../../../components/charts/BarChart.js';
import { ChartContainer } from '../../../components/charts/ChartContainer.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

const query: QueryDef<ThroughputReport> = { key: 'fleet-throughput', fetch: signal => apiGet('/api/verse/fleet/runs/throughput?hours=24&by=lane', signal) };
const shown = (value: number | null): string => value === null ? 'unknown' : String(value);
const minutes = (seconds: number | null): number | null => seconds === null ? null : Math.round(seconds / 6) / 10;
const percent = (rate: number | null): string => rate === null ? 'unknown' : `${Math.round(rate * 100)}%`;
const when = (stamp: string): string => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const cells = (c: ThroughputCounts) => <><td>{shown(c.launched)}</td><td>{shown(c.published)}</td><td>{shown(c.merged)}</td><td>{shown(c.empty)}</td><td>{percent(c.empty_rate)}</td><td>{shown(minutes(c.median_publish_to_merge_s))}</td></>;
const HEAD = <><th>Launched</th><th>Published</th><th>Merged</th><th>Empty</th><th>Empty rate</th><th>Median merge (minutes)</th></>;

export function ThroughputPane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  // Any other payload (an older server, an error body) is not a measurement.
  const report = read.data?.schema === 'throughput.v1' ? read.data : null;
  if (!report) return <section aria-label="Throughput"><h2>Throughput</h2><p>{read.status === 'error' || read.data ? 'Throughput: unknown (the report could not be read).' : 'Reading throughput…'}</p></section>;
  const known = report.metrics === 'ok';
  const hours = report.buckets, total = report.totals;
  const quiet = known && !total.launched && !total.published && !total.merged && !total.finished;
  const timed = hours.some(hour => hour.median_publish_to_merge_s !== null);
  const unknown = 'Unknown: the job metrics file could not be read.';
  return <section aria-label="Throughput"><h2>Throughput</h2>
    <p><strong>{report.headline}.</strong></p>
    <p>{quiet ? `No jobs or PRs were recorded in the last ${report.hours} hours.`
      : `Launched ${shown(total.launched)} · published ${shown(total.published)} · merged ${shown(total.merged)} · empty ${shown(total.empty)} of ${shown(total.finished)} finished (${percent(total.empty_rate)}).`}
    {' '}Main is {report.main}. Updated {when(report.as_of)}.</p>
    {report.malformed_lines ? <p>Metrics lines skipped because they could not be read: {report.malformed_lines}.</p> : null}
    {total.merge_time_unknown ? <p>Merged PRs with no publish time, left out of the median: {total.merge_time_unknown}.</p> : null}
    <ChartContainer title="Merged per hour" description={`PRs merged in each of the last ${report.hours} hours.`} empty={!known} emptyMessage={unknown}
      table={known ? <table><caption>Throughput by hour</caption><thead><tr><th>Hour starting</th>{HEAD}</tr></thead>
        <tbody>{hours.map(hour => <tr key={hour.start}><td>{when(hour.start)}</td>{cells(hour)}</tr>)}</tbody></table> : undefined}>
      <LineChart series={[{ id: 'merged', label: 'Merged', points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.merged })) }]} height={120} ariaLabel="PRs merged per hour" />
    </ChartContainer>
    <ChartContainer title="Median merge time" description="Minutes from publish to merge, by the hour the PR merged. Gaps are hours with no timed merge."
      empty={!timed} emptyMessage={known ? 'No merged PR with a known publish time in this window.' : unknown}>
      <LineChart series={[{ id: 'median', label: 'Median minutes', points: hours.map(hour => ({ x: Date.parse(hour.start), y: minutes(hour.median_publish_to_merge_s) })) }]}
        height={120} formatY={value => `${value} min`} ariaLabel="Median minutes from publish to merge per hour" />
    </ChartContainer>
    <ChartContainer title="Empty rate by lane" description="Share of finished jobs that changed nothing. A dash means no job finished on that lane."
      empty={!report.groups.length} emptyMessage={known ? 'No lane activity in this window.' : unknown}
      table={report.groups.length ? <table><caption>Throughput by lane</caption><thead><tr><th>Lane</th>{HEAD}</tr></thead>
        <tbody>{report.groups.map(group => <tr key={group.name}><td>{group.name}</td>{cells(group.totals)}</tr>)}</tbody></table> : undefined}>
      <BarChart orientation="horizontal" data={report.groups.map(group => ({ label: group.name, value: group.totals.empty_rate === null ? null : Math.round(group.totals.empty_rate * 100) }))}
        height={Math.max(60, report.groups.length * 34)} formatValue={value => `${value}%`} ariaLabel="Empty rate by lane" />
    </ChartContainer>
  </section>;
}
