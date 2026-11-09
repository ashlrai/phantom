/**
 * Robinhood-style Growth charts: one primary series, a 1H/1D/1W/1M range,
 * and a sparkline for every series `phm growth --json` returns.
 * A series with no ledger says "no data source". Nothing here is invented.
 */
import { useMemo, useState } from 'react';
import { AreaTrend } from '../../../components/charts/AreaTrend.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { CHART_SEQUENTIAL } from '../../../components/charts/colors.js';
import { formatCompact, formatUsd } from '../../../components/charts/format.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import {
  GROWTH_RANGES,
  type GrowthRange,
  type GrowthReport,
  type GrowthSeries,
  type GrowthUnit,
} from '../../../../core/growth/series.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { growthSeriesQuery } from './growth-data.js';
import styles from './GrowthCharts.module.css';

export const GROWTH_SERIES_POLL_MS = 10_000;

const RANGE_LABEL: Record<GrowthRange, string> = {
  '1H': 'Last hour',
  '1D': 'Last day',
  '1W': 'Last week',
  '1M': 'Last month',
};

function formatUnit(unit: GrowthUnit, value: number): string {
  switch (unit) {
    case 'merges_per_hour':
      return value >= 10 ? formatCompact(value) : value.toFixed(2);
    case 'count':
      return formatCompact(value);
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'usd':
      return formatUsd(value);
    default: {
      const unexpected: never = unit;
      throw new Error(`Unknown growth unit ${String(unexpected)}`);
    }
  }
}

function latest(series: GrowthSeries): number | null {
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const y = series.points[i]!.y;
    if (y !== null) return y;
  }
  return null;
}

export interface GrowthChartViewProps {
  report: GrowthReport | null;
  loading: boolean;
  refreshing: boolean;
  failed: boolean;
  range: GrowthRange;
  focus: string | null;
  onRange: (range: GrowthRange) => void;
  onFocus: (id: string) => void;
}

export function GrowthChartView({ report, loading, refreshing, failed, range, focus, onRange, onFocus }: GrowthChartViewProps) {
  const active = report?.series.find((series) => series.id === (focus ?? report.primaryId)) ?? report?.series[0] ?? null;
  const chartStatus: ChartStatus = loading
    ? { kind: 'loading' }
    : !report || failed
      ? { kind: 'unknown', reason: 'growth series did not answer.' }
      : active?.status === 'ready'
        ? { kind: 'ready' }
        : { kind: 'unknown', reason: 'no data source.' };
  const points = active?.status === 'ready'
    ? active.points.map((point) => ({ x: Date.parse(point.t), y: point.y }))
    : [];
  return (
    <div className={styles.panel} data-testid="growth-charts">
      <div className={styles.ranges} role="group" aria-label="Range">
        {refreshing ? <RefreshIndicator /> : null}
        {GROWTH_RANGES.map((item) => (
          <button
            key={item}
            type="button"
            className={styles.range}
            aria-pressed={item === range}
            onClick={() => onRange(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <AreaTrend
        title={active?.label ?? 'Fleet growth'}
        description={failed
          ? 'growth series did not answer.'
          : active?.status === 'ready'
            ? `${RANGE_LABEL[range]} · ${active.source ?? 'measured'}${active.freshness === 'stale' ? ' · stale' : ''}`
            : active?.need ?? 'no data source'}
        caveat={active?.caveat ?? undefined}
        status={chartStatus}
        height={280}
        series={[{ id: active?.id ?? 'growth', label: active?.label ?? 'Fleet growth', color: CHART_SEQUENTIAL, points }]}
        formatY={(value) => active ? formatUnit(active.unit, value) : formatCompact(value)}
      />
      {report ? (
        <div className={styles.tiles} role="group" aria-label="Growth series">
          {report.series.map((series) => {
            const value = latest(series);
            const selected = series.id === (focus ?? report.primaryId);
            return (
              <button
                key={series.id}
                type="button"
                className={styles.tile}
                aria-pressed={selected}
                aria-label={series.label}
                onClick={() => onFocus(series.id)}
              >
                <span className={styles.label}>{series.label}</span>
                {series.status === 'ready' ? (
                  <span className={styles.value}>{value === null ? '—' : formatUnit(series.unit, value)}{series.freshness === 'stale' ? ' stale' : ''}</span>
                ) : (
                  <span className={styles.missing}>no data source</span>
                )}
                {series.status === 'ready' ? (
                  <span className={styles.spark}>
                    <Sparkline
                      points={series.points.map((point) => point.y)}
                      width="fill"
                      height={28}
                      area
                      ariaLabel={`${series.label} trend`}
                      describe={(item) => formatUnit(series.unit, item)}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function GrowthCharts() {
  const [range, setRange] = useState<GrowthRange>('1D');
  const [focus, setFocus] = useState<string | null>(null);
  const queryDef = useMemo(() => growthSeriesQuery(range), [range]);
  const query = useQuery(queryDef, { freshMs: 5_000 });
  const refetch = useRefetch(queryDef);
  usePollWhileVisible(refetch, GROWTH_SERIES_POLL_MS);
  const report = query.data?.schema === 'growth.series.v1' ? query.data : null;
  return (
    <GrowthChartView
      report={report}
      loading={query.status === 'loading' || query.status === 'idle'}
      refreshing={query.status === 'refreshing'}
      failed={query.status === 'error' || (query.data !== undefined && report === null)}
      range={range}
      focus={focus}
      onRange={setRange}
      onFocus={setFocus}
    />
  );
}
