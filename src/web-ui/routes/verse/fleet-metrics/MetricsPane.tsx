/** Metrics pane: one board of the fleet's pace over the last 24 hours. The four numbers, the two hourly charts, where the merges landed,
 * where the loop waits and what the merges were for, then lanes, spend-down, job kinds, generators and releases, each in its own card. Everything is read from GET /api/verse/fleet/runs/metrics
 * (the `phm metrics` and `phm jobs yield` reports plus the hourly series) and GET /api/fleet/releases; nothing is summed in the browser but the per-repo totals of that series. */
import type { MetricsPanel } from '../../../../core/fleet/metrics-panel.js';
import type { ReleasesReport } from '../../../../core/release/status.js';
import { ChartContainer } from '../../../components/charts/ChartContainer.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { StatTileSkeleton } from '../../../components/charts/StatTile.js';
import { Button } from '../../../components/primitives/Button.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useState } from 'react';
import { JobYieldCard } from './JobYieldCard.js';
import { LeverageTile } from './LeverageTile.js';
import { LoopStagesCard, type LoopWindow } from './LoopStagesCard.js';
import { MetricsGlance } from './MetricsGlance.js';
import { ReleasesCard } from './ReleasesCard.js';
import { busiestHour, mergedTrend, repoShares } from './metrics-board-model.js';
import { releasesQuery } from './releases-query.js';
import styles from './fleet-metrics.module.css';

const query: QueryDef<MetricsPanel> = { key: 'fleet-metrics-panel', fetch: signal => apiGet('/api/verse/fleet/runs/metrics', signal) };
// The stage card's 7 day window reads the same route with ?since=7d; it is fetched only once someone picks it.
const weekQuery: QueryDef<MetricsPanel> = { key: 'fleet-metrics-panel-7d', fetch: signal => apiGet('/api/verse/fleet/runs/metrics?since=7d', signal) };
/** What the stage card shows: the report for the chosen window and the control that changes it. */
interface LoopView { report: MetricsPanel['loopStages'] | undefined; range: LoopWindow; onWindow: (next: LoopWindow) => void }
const hourLabel = (stamp: string) => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Board({ data, releases, loop }: { data: MetricsPanel; releases: ReleasesReport | undefined; loop: LoopView }) {
  const history = data.series;
  const hours = history?.hours ?? [];
  const repos = [...new Set(hours.flatMap(hour => Object.keys(hour.byRepo)))].sort();
  const mergeSeries = repos.length ? repos.map(repo => ({ id: repo, label: repo,
    points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.merged === null ? null : hour.byRepo[repo] ?? 0 })) })) :
    [{ id: 'all', label: 'All repos', points: hours.map(hour => ({ x: Date.parse(hour.start), y: hour.merged })) }];
  const capacity = Object.fromEntries((data.lanes ?? []).map(row => [row.lane, `${row.running ?? 'unknown'} / ${row.target ?? 'unknown'}`]));
  const shares = repoShares(history);
  const peak = busiestHour(history);
  const generators = data.generatorYield;
  return <>
    <p className={styles.headline}>Merged PRs: {history?.mergesLastHour ?? 'unknown'} in the last hour · {history?.mergesLast24h ?? 'unknown'} in the last 24 hours.</p>
    <p className={styles.meta}>{peak ? `Busiest hour started ${hourLabel(peak.start)} with ${peak.merged} merged. ` : ''}Updated {history?.observedAt ? hourLabel(history.observedAt) : 'unknown'}.</p>
    {history?.known && history.malformedLines > 0 ? <p className={styles.note} data-warn="">Merge history skipped {history.malformedLines} malformed lines.</p> : null}
    <MetricsGlance report={data.glance} capacity={capacity} trend={mergedTrend(history)} below={<>
      <div className={styles.charts}>
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
      </div>
      {shares.length ? <div className={styles.card}>
        <h3 className={styles.heading}>Where the merges landed</h3>
        <ul className={styles.repos} aria-label="Merged PRs by repo, last 24 hours">{shares.map(row => <li key={row.repo}>
          <span className={styles.repoName}>{row.repo}</span>
          <span className={styles.bar} aria-hidden="true"><span className={styles.used} style={{ width: `${row.barPct}%` }} /></span>
          <span className={styles.repoFacts}>{row.merged} merged · {row.sharePct}%</span></li>)}</ul>
      </div> : null}
    </>} />
    {/* Where a job's time goes, beside what the merges were for. */}
    <div className={styles.charts}>
      <LoopStagesCard report={loop.report} range={loop.range} onWindow={loop.onWindow} />
      <LeverageTile report={data.leverage} />
    </div>
    <JobYieldCard report={data.jobYield} stopped={data.stopped} />
    <div className={styles.card}>
      <h3 className={styles.heading}>Jobs by generator</h3>
      <p className={styles.note}>Last 24 hours. Empty rate uses jobs with a recorded empty result. Tokens per merged PR includes all jobs in the group.</p>
      {!generators?.known ? <p className={styles.note}>Generator measurements: unknown</p> : <>
        {generators.malformedLines > 0 ? <p className={styles.note} data-warn="">Malformed lines skipped: {generators.malformedLines}</p> : null}
        {!generators.generators.length ? <p className={styles.note}>No job recorded a generator in this window.</p> : <div className={styles.scroll}>
          <table className={styles.table}><thead><tr><th scope="col">Generator</th><th scope="col">Jobs</th><th scope="col">PRs</th><th scope="col">Merged</th><th scope="col">Empty rate</th><th scope="col">Median diff lines</th><th scope="col">Tokens per merged PR</th></tr></thead>
            <tbody>{generators.generators.map(row => <tr key={row.generator}><th scope="row">{row.generator}</th><td>{row.jobs}</td><td>{row.prs}</td><td>{row.merged}</td>
              <td>{row.emptyRate === null ? 'unknown' : `${(row.emptyRate * 100).toFixed(1)}%`}</td><td>{row.medianDiffLines ?? 'unknown'}</td><td>{row.tokensPerMergedPr?.toLocaleString() ?? 'unknown'}</td></tr>)}</tbody></table>
        </div>}
      </>}
    </div>
    <ReleasesCard report={releases} />
  </>;
}

export function MetricsPane({ visible }: PaneProps) {
  // Tags move slowly, so this is read when the pane opens and kept for five minutes.
  const releases = useQuery(releasesQuery, { enabled: visible, freshMs: 300_000 });
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const [loopWindow, setLoopWindow] = useState<LoopWindow>('24h');
  const week = useQuery(weekQuery, { enabled: visible && loopWindow === '7d', freshMs: 0 });
  const refresh = useRefetch(query);
  const refreshWeek = useRefetch(weekQuery);
  usePollWhileVisible(() => { refresh(); if (loopWindow === '7d') refreshWeek(); }, 60_000, { enabled: visible });
  const data = read.data;
  const loop: LoopView = { report: loopWindow === '7d' ? week.data?.loopStages : data?.loopStages, range: loopWindow, onWindow: setLoopWindow };
  return <section className={styles.board} aria-label="Metrics">
    <h2 className={styles.title}>Metrics</h2>
    {/* A failed refresh keeps the last board on screen; it must not read as current. */}
    {data && read.status === 'error' ? <p className={styles.note} data-warn="" role="status">Could not refresh. Showing the last reading.</p> : null}
    {data ? <Board data={data} releases={releases.data} loop={loop} />
      : read.status === 'error' ? <div className={styles.card} role="alert">
        <p className={styles.headline}>Metrics are unknown.</p>
        <p className={styles.note}>The metrics report could not be read, so no number is shown.</p>
        <div><Button variant="subtle" size="sm" onClick={refresh}>Try again</Button></div>
      </div>
      // First read: tiles in the shape of the four numbers, so the board does not jump when they land.
      : <><p className={styles.meta} role="status">Reading metrics…</p>
        <div className={styles.tiles}>{[0, 1, 2, 3].map(i => <StatTileSkeleton key={i} trend={i === 0} />)}</div></>}
  </section>;
}
