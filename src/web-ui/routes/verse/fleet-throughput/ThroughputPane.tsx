/** Throughput pane: the `phm throughput` report as one board. Headline, a row of figures each over its own hourly line,
 * the fleet's hours as a row of bars, the launched → published → merged flow, two hourly charts and a card per lane
 * (ThroughputBoard.tsx). The window switch asks the same route for 6 hours, 24 hours or 7 days, so no window total is
 * summed in the browser. The rows of bars are one reading cursor (HourBars.tsx): the bar held is kept here, by its start. */
import { useMemo, useState } from 'react';
import type { ThroughputBy, ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ChartContainer } from '../../../components/charts/ChartContainer.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { Funnel } from '../../../components/charts/Funnel.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { Button } from '../../../components/primitives/Button.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { cursorAt } from '../models/model-work-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ThroughputHours } from './HourBars.js';
import { cursorBars } from './throughput-cursor-model.js';
import { ThroughputFigures, ThroughputFiguresSkeleton, ThroughputLanes } from './ThroughputBoard.js';
import { ThroughputShare } from './ThroughputShare.js';
import { groupWords } from './throughput-share-model.js';
import styles from './fleet-throughput.module.css';
import { THROUGHPUT_GROUP_QUERIES, THROUGHPUT_GROUPS, THROUGHPUT_WINDOWS, type ThroughputWindow } from './throughput-query.js';

// The window reads live in throughput-query.ts: Home's Merged PRs card shares the 24 hour one.
const WINDOWS = THROUGHPUT_WINDOWS, GROUPS = THROUGHPUT_GROUPS, QUERIES = THROUGHPUT_GROUP_QUERIES;
type Window = ThroughputWindow;
const shown = (value: number | null): string => value === null ? 'unknown' : String(value);
const minutes = (seconds: number | null): number | null => seconds === null ? null : Math.round(seconds / 6) / 10;
const percent = (rate: number | null): string => rate === null ? 'unknown' : `${Math.round(rate * 100)}%`;
const when = (stamp: string): string => new Date(stamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const cells = (c: ThroughputCounts) => <><td>{shown(c.launched)}</td><td>{shown(c.published)}</td><td>{shown(c.merged)}</td><td>{shown(c.empty)}</td><td>{percent(c.empty_rate)}</td><td>{shown(minutes(c.median_publish_to_merge_s))}</td></>;
const HEAD = <><th>Launched</th><th>Published</th><th>Merged</th><th>Empty</th><th>Empty rate</th><th>Median merge (minutes)</th></>;

function Report({ report }: { report: ThroughputReport }) {
  const known = report.metrics === 'ok';
  const hours = report.buckets, total = report.totals;
  const quiet = known && !total.launched && !total.published && !total.merged && !total.finished;
  const timed = hours.some(hour => hour.median_publish_to_merge_s !== null);
  // The reading cursor: the start of the bar held on every row. A refresh that moves the window on lets go by itself.
  const [cursor, setCursor] = useState<string | null>(null);
  const fleet = useMemo(() => known ? cursorBars(hours) : [], [known, hours]);
  const held = fleet[cursorAt(fleet, cursor) ?? -1] ?? null;
  const group = groupWords(report.by);
  const unknown = 'Unknown: the job metrics file could not be read.';
  // Stated outright: a window with merges but no launches is still a flow, and an unreadable file is unknown, never an empty one.
  const flow: ChartStatus = !known ? { kind: 'unknown', reason: 'the job metrics file could not be read.' }
    : quiet ? { kind: 'empty', message: 'Nothing was launched, published or merged in this window.' } : { kind: 'ready' };
  return <>
    <p className={styles.headline}>{report.headline}.</p>
    <p className={styles.meta}>{quiet ? `No jobs or PRs were recorded in the last ${report.hours} hours.`
      : `Empty ${shown(total.empty)} of ${shown(total.finished)} finished (${percent(total.empty_rate)}).`}
    {' '}<span className={styles.main} data-main={report.main}>Main is {report.main}.</span> Updated {when(report.as_of)}.</p>
    {report.malformed_lines ? <p className={styles.note}>Metrics lines skipped because they could not be read: {report.malformed_lines}.</p> : null}
    {total.merge_time_unknown ? <p className={styles.note}>Merged PRs with no publish time, left out of the median: {total.merge_time_unknown}.</p> : null}
    <ThroughputFigures report={report} held={held} />
    <ThroughputHours bars={fleet} cursor={cursor} onCursor={setCursor} />
    <Funnel title="Delivery flow" description={`Jobs launched, PRs published and PRs merged in the last ${report.hours} hours.`} status={flow} formatValue={String}
      caveat={flow.kind === 'ready' ? 'Each count is what happened inside this window, not one batch followed through: a PR merged here may have been launched before it.' : undefined}
      stages={[{ id: 'launched', label: 'Launched', value: total.launched }, { id: 'published', label: 'Published', value: total.published }, { id: 'merged', label: 'Merged', value: total.merged }]} />
    <div className={styles.pair}>
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
    </div>
    <ChartContainer title={group.title} description={`Most PRs merged first. The bar compares a ${group.one} with the one that merged most; the row of bars is its jobs launched across the window, against the busiest bar on any ${group.one}.`}
      empty={!report.groups.length} emptyMessage={known ? `No ${group.one} activity in this window.` : unknown}
      table={report.groups.length ? <table><caption>Throughput by {group.one}</caption><thead><tr><th>{group.column}</th>{HEAD}</tr></thead>
        <tbody>{report.groups.map(group => <tr key={group.name}><td>{group.name}</td>{cells(group.totals)}</tr>)}</tbody></table> : undefined}>
      <ThroughputShare groups={report.groups} by={report.by} />
      <ThroughputLanes groups={report.groups} by={report.by} cursor={cursor} onCursor={setCursor} />
    </ChartContainer>
  </>;
}

export function ThroughputPane({ visible }: PaneProps) {
  const [hours, setHours] = useState<Window>('24');
  const [by, setBy] = useState<ThroughputBy>('lane');
  const query = QUERIES[by][hours];
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  // Any other payload (an older server, an error body) is not a measurement.
  const report = read.data?.schema === 'throughput.v1' ? read.data : null;
  // The switch stays put while a window is read, so a slow or failed read never takes the way back with it.
  return <section className={styles.root} aria-label="Throughput">
    <div className={styles.head}><h2>Throughput</h2><div className={styles.switches}><Segmented size="sm" aria-label="Group by" options={GROUPS} value={by} onChange={setBy} /><Segmented size="sm" aria-label="Window" options={WINDOWS} value={hours} onChange={setHours} /></div></div>
    {/* A failed refresh keeps the last report on screen; it must not read as current. */}
    {report && read.status === 'error' ? <p className={styles.note} data-stale role="status">Could not refresh. Showing the last reading.</p> : null}
    {report ? <Report key={`${report.hours}:${report.by}`} report={report} />
      : read.status === 'error' || read.data
        ? <div className={styles.unread}><p className={styles.meta} role="status">Throughput: unknown (the report could not be read).</p><Button size="sm" onClick={refresh}>Try again</Button></div>
        : <><p className={styles.meta} role="status">Reading throughput…</p><ThroughputFiguresSkeleton /></>}
  </section>;
}
