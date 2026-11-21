/**
 * One pool's window so far, on its Pools card: every stored reading from the window's start to its reset, the dashed
 * even line from 0% to 100%, a rule at now and, ahead of the newest reading, the line to where pools.v1 says this
 * burn ends. The sentence under the plot says the same in words. A window that cannot be drawn says why instead.
 *
 * Each reading can be read on its own: pointing at the plot picks the reading drawn nearest, and with the plot
 * focused Left and Right step through them (Home and End jump to the oldest and newest, Esc lets go). A rule and a
 * ring mark the reading and the sentence under the plot becomes that reading's time, used share and even line.
 */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PoolRow } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';
import { gapWords, nearestReading, poolWindow, readingAt, readingCount, readingWords, stepReading, type WindowChart, type WindowPoint } from './pool-window-model.js';
import styles from './pool-window.module.css';

export type WindowRead = 'loading' | 'failed' | 'ready';

export const windowDay = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
/** When one reading was taken, to the minute: "Sun, Nov 15, 12:00 PM". */
export const readingTime = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// The plot is 100 by 100 and stretched to the card, so a point is `x,100 - y` and lines keep their width through `vector-effect`.
const at = (point: WindowPoint): string => `${point.x},${Math.round((100 - point.y) * 100) / 100}`;

export function PoolWindow({ row, series, read, now }: { row: PoolRow; series: PoolUsageSeries | undefined; read: WindowRead; now: number }) {
  // A failed read is said once, above the list, not on every card.
  if (read === 'failed') return null;
  if (read === 'loading') return <div className={styles.skeleton} data-window="loading" aria-hidden="true" />;
  const window = poolWindow(series, row, now);
  if (window.kind === 'none') return <p className={styles.none} data-window="none">{window.why}</p>;
  return <WindowFigure row={row} chart={window.chart} reason={series?.reason ?? null} />;
}

function WindowFigure({ row, chart, reason }: { row: PoolRow; chart: WindowChart; reason: string | null }) {
  // The reading being read, by its place in the chart. A refresh that leaves fewer readings simply lets go of it.
  const [picked, setPicked] = useState<number | null>(null);
  const count = chart.points.length;
  const last = chart.points.at(-1)!;
  const reading = picked === null ? null : readingAt(chart, picked);
  const mark = reading ? chart.points[reading.index]! : null;
  const summary = `${readingCount(chart)} since ${windowDay(chart.startMs)}. ${gapWords(chart)}`;

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!(box.width > 0)) return;
    const near = nearestReading(chart, (event.clientX - box.left) / box.width * 100);
    if (near >= 0) setPicked(near);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Esc lets go of the reading first; a second Esc is the pane's.
      if (reading) { event.stopPropagation(); setPicked(null); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = stepReading(event.key, reading?.index ?? count - 1, count);
    if (next === null) return;
    event.preventDefault();
    setPicked(next);
  };

  return <figure className={styles.window} data-window="chart" data-risk={row.wasteRisk}>
    <div className={styles.frame}>
      <span className={styles.top} aria-hidden="true">100%</span>
      <span className={styles.mid} aria-hidden="true">50%</span>
      <div className={styles.plot}>
        <svg className={styles.svg} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${row.id} window so far: ${summary}`}>
          <line className={styles.grid} x1="0" y1="50" x2="100" y2="50" />
          {chart.days.map(x => <line key={x} className={styles.day} data-line="day" x1={x} y1="0" x2={x} y2="100" />)}
          <line className={styles.even} data-line="even" x1="0" y1="100" x2="100" y2="0" />
          {chart.nowX === null ? null : <line className={styles.now} data-line="now" x1={chart.nowX} y1="0" x2={chart.nowX} y2="100" />}
          {count > 1 ? <>
            <polygon className={styles.wash} points={`${chart.points[0]!.x},100 ${chart.points.map(at).join(' ')} ${last.x},100`} />
            <polyline className={styles.measured} data-line="measured" points={chart.points.map(at).join(' ')} />
          </> : null}
          {chart.ahead ? <line className={styles.ahead} data-line="ahead" x1={chart.ahead.from.x} y1={100 - chart.ahead.from.y} x2={chart.ahead.to.x} y2={100 - chart.ahead.to.y} /> : null}
        </svg>
        {/* An HTML dot: a circle inside the stretched plot would be drawn as an ellipse. */}
        <span className={styles.dot} data-point="latest" style={{ left: `${last.x}%`, bottom: `${last.y}%` }} />
        {reading && mark ? <>
          <span className={styles.rule} data-rule="picked" style={{ left: `${mark.x}%` }} />
          <span className={styles.ring} data-point="picked" style={{ left: `${mark.x}%`, bottom: `${mark.y}%` }} />
          {/* The figure sits clear of its ring: under the top edge, or along the bottom for a reading high on the plot. */}
          <span className={styles.value} data-side={mark.x < 12 ? 'start' : mark.x > 88 ? 'end' : undefined} data-low={mark.y > 60 || undefined}
            style={{ left: `${mark.x}%` }} aria-hidden="true">{reading.usedPct}%</span>
        </> : null}
        {/* Over the whole plot and last, so it takes the pointer. A slider: one value per stored reading, said in full. */}
        <div className={styles.scrub} role="slider" tabIndex={0} aria-label={`${row.id} stored readings`} aria-orientation="horizontal"
          aria-valuemin={1} aria-valuemax={count} aria-valuenow={(reading?.index ?? count - 1) + 1}
          aria-valuetext={readingWords(reading ?? readingAt(chart, count - 1)!, readingTime)}
          onPointerMove={point} onPointerDown={point}
          onPointerLeave={event => { if (document.activeElement !== event.currentTarget) setPicked(null); }}
          onFocus={() => setPicked(index => index ?? count - 1)} onBlur={() => setPicked(null)} onKeyDown={key} />
      </div>
      <span className={styles.axis} aria-hidden="true">
        <span>{windowDay(chart.startMs)}</span>
        {chart.nowX !== null && chart.nowX > 18 && chart.nowX < 86 ? <span className={styles.nowWord} style={{ left: `${chart.nowX}%` }}>now</span> : null}
        <span>reset</span>
      </span>
    </div>
    {reading
      ? <figcaption className={styles.caption} data-reading={reading.index + 1}>{readingWords(reading, readingTime)}</figcaption>
      : <figcaption className={styles.caption}>
        {summary}
        {chart.ahead ? ' Dotted: where this burn leads.' : ''}
        {reason ? ` ${reason}` : ''}
      </figcaption>}
  </figure>;
}
