/** The Throughput board's two drawn parts: a row of figure tiles, each over its own hourly line, and one card per lane.
 * Shaping lives in throughput-board-model.ts; this file only draws it. An unknown figure is the word, with no line under it. */
import type { ThroughputGroup, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { StatTile, StatTileSkeleton } from '../../../components/charts/StatTile.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { figures, laneRows, type Figure, type LaneRow, type Peak } from './throughput-board-model.js';
import styles from './throughput-board.module.css';

const hourOf = (stamp: string, days: boolean): string =>
  new Date(stamp).toLocaleString(undefined, days ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric' });
const peakText = (peak: Peak, days: boolean): string => `Most in one hour: ${peak.value}, from ${hourOf(peak.start, days)}`;
const word = (text: string, known: boolean) => known ? text : <span className={styles.unknown}>{text}</span>;

function tile(figure: Figure, days: boolean) {
  const caption = figure.peak ? peakText(figure.peak, days) : figure.caption;
  return <li key={figure.id} data-figure={figure.id}>
    <StatTile label={figure.label} value={word(figure.value, figure.known)} caption={caption ?? undefined}
      trend={figure.trend ?? undefined} trendLabel={figure.trendLabel} describeTrend={String} />
  </li>;
}

/** Launched, published, merged, changed nothing and the median merge time for the window. */
export function ThroughputFigures({ report }: { report: ThroughputReport }) {
  // Past a day the hour alone does not say which day it was.
  const days = report.hours > 24;
  return <ul className={styles.figures} aria-label={`Figures for the last ${report.hours} hours`}>{figures(report).map(figure => tile(figure, days))}</ul>;
}

/** The same row while the first report is read. The pane says "Reading throughput…" once for all of it. */
export function ThroughputFiguresSkeleton() {
  return <div className={styles.figures} aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <StatTileSkeleton key={i} />)}</div>;
}

function LaneCard({ lane }: { lane: LaneRow }) {
  const percent = lane.emptyRate === null ? null : Math.round(lane.emptyRate * 100);
  return <li className={styles.lane} data-lane={lane.name}>
    <div className={styles.laneHead}>
      <span className={styles.laneName}><BrandMark brand={lane.name} size={16} />{lane.name}</span>
      <span className={styles.laneCount}>{word(lane.merged === null ? 'unknown' : String(lane.merged), lane.merged !== null)} <span className={styles.unit}>merged</span></span>
    </div>
    {/* Each line has its own scale, so the bar is what compares one lane with another. */}
    <div className={styles.track} data-unknown={lane.share === null ? '' : undefined}>
      {lane.share === null ? null : <span className={styles.fill} style={{ width: `${Math.round(lane.share * 100)}%` }} />}
    </div>
    {lane.trend ? <Sparkline points={lane.trend} width="fill" height={28} area ariaLabel={`${lane.name}: PRs merged per hour`} describe={String} /> : null}
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
export function ThroughputLanes({ groups }: { groups: readonly ThroughputGroup[] }) {
  return <ul className={styles.lanes} aria-label="Lanes, most merged first">{laneRows(groups).map(lane => <LaneCard key={lane.name} lane={lane} />)}</ul>;
}
