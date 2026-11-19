/** Trends: one small line chart per scoreboard number and per plan, with the latest value and the change in plain words. Same read as `phm fleet score --trend <24h|7d> --json`. */
import type { Scoreboard } from '../../../../core/fleet/scoreboard.js';
import { trendValue, type TrendReport, type TrendSeries, type TrendWindow } from '../../../../core/fleet/scoreboard-trend.js';
import { LineChart } from '../../../components/charts/LineChart.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './fleet-scoreboard.module.css';

const queries: Record<TrendWindow, QueryDef<Scoreboard>> = {
  '24h': { key: 'fleet-scoreboard-trend-24h', fetch: signal => apiGet('/api/verse/fleet/runs/scoreboard?trend=24h', signal) },
  '7d': { key: 'fleet-scoreboard-trend-7d', fetch: signal => apiGet('/api/verse/fleet/runs/scoreboard?trend=7d', signal) },
};

/** A reset breaks the line (a point just before it with no value) so it never draws a slide from the old window to the new one. */
function points(series: TrendSeries, starts: string[]): { x: number; y: number | null }[] {
  return series.values.flatMap((y, i) => {
    const x = Date.parse(starts[i]!);
    return series.resets.includes(i) ? [{ x: x - 1, y: null }, { x, y }] : [{ x, y }];
  });
}

export function TrendCard({ series, report }: { series: TrendSeries; report: TrendReport }) {
  const direction = series.change.direction;
  return <li className={styles.card} aria-label={series.label}>
    <h3>{series.label}</h3>
    <p className={styles.value}><span>{trendValue(series.latest, series.unit)}</span>
      <span className={styles.trend} data-trend={direction ?? 'unknown'}>{series.change.words}</span></p>
    <LineChart series={[{ id: series.key, label: series.label, points: points(series, report.bucket_starts) }]} height={80}
      formatY={v => trendValue(v, series.unit)} ariaLabel={series.summary} />
    {series.resets.length ? <p className={styles.caption}>↺ Reset at {series.resets.map(i => report.bucket_starts[i]!.slice(11, 16)).join(', ')} (UTC): the line breaks there.</p> : null}
  </li>;
}

export function ScoreboardTrends({ window, visible }: { window: TrendWindow; visible: boolean }) {
  const read = useQuery(queries[window], { enabled: visible, freshMs: 0 });
  const report = read.data?.trend;
  if (!report) return <p className={styles.note}>{read.status === 'error' ? 'Trends are unknown.' : 'Reading the trends…'}</p>;
  return <section aria-label="Trends" className={styles.root}>
    <h2>Trends</h2>
    <p className={styles.note}>{report.sentence} A gap in a line means no data, not zero.</p>
    <ul className={styles.cards} aria-label="Trend charts">
      {[...report.metrics, ...report.pools].map(series => <TrendCard key={series.key} series={series} report={report} />)}
    </ul>
  </section>;
}
