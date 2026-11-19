import type { PoolUsageSeries, UsagePace } from '../../../../core/fleet/usage-history.js';
import styles from './UsageHistoryChart.module.css';

const W = 200, H = 48, PAD = 2;
const time = (iso: string): number => Date.parse(iso);

/** Plain words for the reset: "Resets Fri, Nov 20, 4:00 PM", or why it is unknown. */
export function resetLabel(resetAt: string | null, now: number): string {
  const at = resetAt === null ? NaN : time(resetAt);
  if (!Number.isFinite(at)) return 'Reset time unknown';
  const words = new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return at <= now ? `Reset passed ${words}` : `Resets ${words}`;
}

/**
 * Actual used share against the straight line from 0% at window start to 100%
 * at reset. One reading is one dot: no line is drawn that was not measured.
 * A failed history read says unknown; a pool with no stored readings says so.
 */
export function UsageHistoryChart({ series, status = 'ready', now = Date.now() }:
  { series: PoolUsageSeries | undefined; status?: 'loading' | 'failed' | 'ready'; now?: number }) {
  if (status === 'loading') return null;
  if (status === 'failed') return <p className={styles.empty}>Usage history unknown</p>;
  if (!series || series.points.length === 0) return <p className={styles.empty}>No readings yet</p>;
  const times = series.points.map(p => time(p.at));
  const from = Math.min(...times, series.ideal ? time(series.ideal.from.at) : Infinity);
  const to = Math.max(...times, series.ideal ? time(series.ideal.to.at) : -Infinity);
  const span = to - from;
  const x = (t: number): number => PAD + (span > 0 ? (t - from) / span : 1) * (W - 2 * PAD);
  const y = (pct: number): number => PAD + (1 - Math.min(100, Math.max(0, pct)) / 100) * (H - 2 * PAD);
  const actual = series.points.map(p => [x(time(p.at)), y(p.used_pct)] as const);
  const used = series.used_pct === null ? 'unknown' : `${Math.round(series.used_pct)}% used`;
  const ideal = series.ideal_pct === null ? '' : `, ideal ${Math.round(series.ideal_pct)}% by now`;
  const label = `${series.pool}: ${used}${ideal}. ${resetLabel(series.reset_at, now)}. Pace ${series.pace}.`;
  const nowX = span > 0 && now > from && now < to ? x(now) : null;
  return <figure className={styles.chart} data-pace={paceKey(series.pace)}>
    <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {series.ideal ? <line className={styles.ideal} data-line="ideal" x1={x(time(series.ideal.from.at))} y1={y(0)}
        x2={x(time(series.ideal.to.at))} y2={y(100)} /> : null}
      {nowX !== null ? <line className={styles.now} x1={nowX} y1={0} x2={nowX} y2={H} /> : null}
      {actual.length > 1 ? <polyline className={styles.actual} data-line="actual" points={actual.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} /> : null}
      {actual.length === 1 ? <circle className={styles.dot} data-point="only" cx={actual[0]![0]} cy={actual[0]![1]} r={2.5} /> : null}
    </svg>
    <figcaption className={styles.caption}>
      <span>{resetLabel(series.reset_at, now)}</span>
      <span className={styles.pace}>Pace: {series.pace}</span>
    </figcaption>
    {/* Same sentence as the top of `phm fleet usage-history`: runs dry early, on pace, leaves usage unspent, or unknown. */}
    <span className={styles.reason} data-runway={series.runway.verdict.replace(/ /g, '-')}>{series.runway.sentence}</span>
    {series.reason ? <span className={styles.reason}>{series.reason}</span> : null}
  </figure>;
}

const paceKey = (pace: UsagePace): string => pace.replace(' ', '-');
