/** The Throughput board's two drawn parts: a row of figure tiles, each over its own hourly line, and one card per lane.
 * Shaping lives in throughput-board-model.ts; this file only draws it. An unknown figure is the word, with no line under it.
 * While the reading cursor holds a bar (HourBars.tsx), the tiles show that bar's counts and each lane card says its own. */
import { useMemo } from 'react';
import type { ThroughputGroup, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { StatTile, StatTileSkeleton } from '../../../components/charts/StatTile.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { cursorAt } from '../models/model-work-model.js';
import { HourBars, type HourCursor } from './HourBars.js';
import { figures, laneRows, type Figure, type LaneRow, type Peak } from './throughput-board-model.js';
import { barUnit, busiestWords, cursorBars, heldFigures, laneBarWords, mostLaunched, type HourBar } from './throughput-cursor-model.js';
import styles from './throughput-board.module.css';

const hourOf = (stamp: string, days: boolean): string =>
  new Date(stamp).toLocaleString(undefined, days ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' });
const peakText = (peak: Peak, days: boolean): string => `Most in one hour: ${peak.value}, from ${hourOf(peak.start, days)}`;
const word = (text: string, known: boolean) => known ? text : <span className={styles.unknown}>{text}</span>;

function tile(figure: Figure, days: boolean) {
  const caption = figure.peak ? peakText(figure.peak, days) : figure.caption;
  return <li key={figure.id} data-figure={figure.id} data-held={figure.held ? '' : undefined}>
    <StatTile label={figure.label} value={word(figure.value, figure.known)} caption={caption ?? undefined}
      trend={figure.trend ?? undefined} trendLabel={figure.trendLabel} describeTrend={String} />
  </li>;
}

/** Launched, published, merged, changed nothing and the median merge time for the window, or for the one bar the cursor holds. */
export function ThroughputFigures({ report, held = null }: { report: ThroughputReport; held?: HourBar | null }) {
  // Past a day the hour alone does not say which day it was.
  const days = report.hours > 24;
  const shown = held ? heldFigures(figures(report), held) : figures(report);
  return <ul className={styles.figures} data-reading={held ? '' : undefined} aria-label={`Figures for the last ${report.hours} hours`}>{shown.map(figure => tile(figure, days))}</ul>;
}

/** The same row while the first report is read. The pane says "Reading throughput…" once for all of it. */
export function ThroughputFiguresSkeleton() {
  return <div className={styles.figures} aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <StatTileSkeleton key={i} />)}</div>;
}

function LaneCard({ lane, bars, peak, cursor, onCursor }: HourCursor & { lane: LaneRow; bars: readonly HourBar[] | null; peak: number }) {
  const percent = lane.emptyRate === null ? null : Math.round(lane.emptyRate * 100);
  const at = bars ? cursorAt(bars, cursor) : null;
  return <li className={styles.lane} data-lane={lane.name}>
    <div className={styles.laneHead}>
      <span className={styles.laneName}><BrandMark brand={lane.name} size={16} />{lane.name}</span>
      <span className={styles.laneCount}>{word(lane.merged === null ? 'unknown' : String(lane.merged), lane.merged !== null)} <span className={styles.unit}>merged</span></span>
    </div>
    {/* Merged against the lane that merged most. */}
    <div className={styles.track} data-unknown={lane.share === null ? '' : undefined}>
      {lane.share === null ? null : <span className={styles.fill} style={{ width: `${Math.round(lane.share * 100)}%` }} />}
    </div>
    {/* Every lane's bars stand against the busiest bar on any lane, so the rows compare; one cursor reads them all. */}
    {bars ? <>
      <HourBars bars={bars} peak={peak} cursor={cursor} onCursor={onCursor} say={laneBarWords}
        label={`${lane.name} jobs launched, a bar per ${barUnit(bars[0]!)}: most in one bar ${mostLaunched([bars])}`} />
      <p className={styles.reading} data-reading={at === null ? undefined : ''}>{at === null ? busiestWords(bars) : laneBarWords(bars[at]!)}</p>
    </> : null}
    <dl className={styles.facts}>
      <div><dt>Launched</dt><dd>{word(lane.launched === null ? 'unknown' : String(lane.launched), lane.launched !== null)}</dd></div>
      <div><dt>Published</dt><dd>{word(lane.published === null ? 'unknown' : String(lane.published), lane.published !== null)}</dd></div>
      <div><dt>Median to merge</dt><dd>{word(lane.median, lane.median !== 'unknown')}</dd></div>
      <div className={styles.wide}><dt>Changed nothing</dt>
        <dd>{word(lane.emptyText, lane.emptyText !== 'unknown')}
          {percent === null ? null : <span className={styles.rate} role="img" aria-label={`${lane.name}: ${lane.emptyText.replace(' (', ' finished jobs changed nothing (')}`}>
            <span className={styles.rateFill} style={{ width: `${percent}%` }} /></span>}
        </dd></div>
    </dl>
  </li>;
}

/** One card per lane, the lane that merged most first. */
export function ThroughputLanes({ groups, cursor, onCursor }: HourCursor & { groups: readonly ThroughputGroup[] }) {
  // A lane with no hour read draws no bars: no reading is never a row of empty ones.
  const bars = useMemo(() => new Map(groups.map(group => {
    const row = cursorBars(group.buckets);
    return [group.name, row.some(bar => bar.read) ? row : null] as const;
  })), [groups]);
  const peak = mostLaunched([...bars.values()].flatMap(row => row ? [row] : []));
  return <ul className={styles.lanes} aria-label="Lanes, most merged first">{laneRows(groups).map(lane =>
    <LaneCard key={lane.name} lane={lane} bars={bars.get(lane.name) ?? null} peak={peak} cursor={cursor} onCursor={onCursor} />)}</ul>;
}
