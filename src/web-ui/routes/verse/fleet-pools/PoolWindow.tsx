/**
 * One pool's window so far, on its Pools card: every stored reading from the window's start to its reset, the dashed
 * even line from 0% to 100%, a rule at now and, ahead of the newest reading, the line to where pools.v1 says this
 * burn ends. The sentence under the plot says the same in words. A window that cannot be drawn says why instead.
 */
import type { PoolRow } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';
import { gapWords, poolWindow, readingCount, type WindowPoint } from './pool-window-model.js';
import styles from './pool-window.module.css';

export type WindowRead = 'loading' | 'failed' | 'ready';

export const windowDay = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
// The plot is 100 by 100 and stretched to the card, so a point is `x,100 - y` and lines keep their width through `vector-effect`.
const at = (point: WindowPoint): string => `${point.x},${Math.round((100 - point.y) * 100) / 100}`;

export function PoolWindow({ row, series, read, now }: { row: PoolRow; series: PoolUsageSeries | undefined; read: WindowRead; now: number }) {
  // A failed read is said once, above the list, not on every card.
  if (read === 'failed') return null;
  if (read === 'loading') return <div className={styles.skeleton} data-window="loading" aria-hidden="true" />;
  const window = poolWindow(series, row, now);
  if (window.kind === 'none') return <p className={styles.none} data-window="none">{window.why}</p>;
  const { chart } = window;
  const last = chart.points.at(-1)!;
  const label = `${row.id} window so far: ${readingCount(chart)} since ${windowDay(chart.startMs)}. ${gapWords(chart)}`;
  return <figure className={styles.window} data-window="chart" data-risk={row.wasteRisk}>
    <div className={styles.frame}>
      <span className={styles.top} aria-hidden="true">100%</span>
      <span className={styles.mid} aria-hidden="true">50%</span>
      <div className={styles.plot}>
        <svg className={styles.svg} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}>
          <line className={styles.grid} x1="0" y1="50" x2="100" y2="50" />
          {chart.days.map(x => <line key={x} className={styles.day} data-line="day" x1={x} y1="0" x2={x} y2="100" />)}
          <line className={styles.even} data-line="even" x1="0" y1="100" x2="100" y2="0" />
          {chart.nowX === null ? null : <line className={styles.now} data-line="now" x1={chart.nowX} y1="0" x2={chart.nowX} y2="100" />}
          {chart.points.length > 1 ? <>
            <polygon className={styles.wash} points={`${chart.points[0]!.x},100 ${chart.points.map(at).join(' ')} ${last.x},100`} />
            <polyline className={styles.measured} data-line="measured" points={chart.points.map(at).join(' ')} />
          </> : null}
          {chart.ahead ? <line className={styles.ahead} data-line="ahead" x1={chart.ahead.from.x} y1={100 - chart.ahead.from.y} x2={chart.ahead.to.x} y2={100 - chart.ahead.to.y} /> : null}
        </svg>
        {/* An HTML dot: a circle inside the stretched plot would be drawn as an ellipse. */}
        <span className={styles.dot} data-point="latest" style={{ left: `${last.x}%`, bottom: `${last.y}%` }} />
      </div>
      <span className={styles.axis} aria-hidden="true">
        <span>{windowDay(chart.startMs)}</span>
        {chart.nowX !== null && chart.nowX > 18 && chart.nowX < 86 ? <span className={styles.nowWord} style={{ left: `${chart.nowX}%` }}>now</span> : null}
        <span>reset</span>
      </span>
    </div>
    <figcaption className={styles.caption}>
      {readingCount(chart)} since {windowDay(chart.startMs)}. {gapWords(chart)}
      {chart.ahead ? ' Dotted: where this burn leads.' : ''}
      {series?.reason ? ` ${series.reason}` : ''}
    </figcaption>
  </figure>;
}
