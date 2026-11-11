/**
 * routes/verse/goals-pane/GoalMetric.tsx: one goal's measured number, a 24h
 * delta arrow and a live/stale/unknown badge. Unknown renders as "unknown",
 * never 0. `useGoalMetrics` is the shared read half — the desktop pane and the
 * phone screen bind the same readings the same way.
 */
import { useMemo } from 'react';
import { bindGoalMetrics, type GoalMetricId, type GoalMetric as Metric, type MetricReading } from '../../../../core/fleet/goal-metrics.js';
import { useQuery } from '../../../data/hooks.js';
import type { GoalSummary } from '../../../data/queries.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { mergeBacklogQuery } from '../fleet-merges/merge-backlog-queries.js';
import { readMergeSpeed } from '../fleet-merges/fleet-merges-model.js';
import { openGoals } from './goals-pane-model.js';
import styles from './goals-pane.module.css';

export function metricValueText(m: Metric): string {
  return m.value === null ? 'unknown' : `${Math.round(m.value * 10) / 10}${m.unit}`;
}

export function deltaText(m: Metric): string {
  if (m.delta24h === null) return 'Δ24h unknown';
  const d = Math.round(m.delta24h * 10) / 10;
  return `${d > 0 ? '▲' : d < 0 ? '▼' : '→'} ${d > 0 ? '+' : ''}${d} / 24h`;
}

export function GoalMetric({ metric }: { metric: Metric }) {
  return (
    <p className={styles.metric} data-state={metric.state}>
      <span className={styles.metricValue}>{metricValueText(metric)}</span>
      <span>{deltaText(metric)}</span>
      <span className={styles.badge}>{metric.state}</span>
      {metric.reason ? <span>{metric.reason}</span> : null}
    </p>
  );
}

const DAY_MS = 24 * 60 * 60_000;
const SAMPLE_GAP_MS = 10 * 60_000;
type Sample = { at: number; value: number };

/**
 * Value from about a day ago for `key`, from samples this browser kept (no
 * producer stores a 24h series). Null until a sample at least 23h old exists.
 */
export function previousDayValue(key: string, value: number | null, now: number, store: Storage | undefined = globalThis.localStorage): number | null {
  if (!store) return null;
  let samples: Sample[] = [];
  try {
    const raw = JSON.parse(store.getItem(`goal-metric:${key}`) ?? '[]') as unknown;
    if (Array.isArray(raw)) samples = raw.filter((s): s is Sample => typeof s?.at === 'number' && typeof s?.value === 'number');
  } catch { /* corrupt baseline: start over */ }
  const baseline = samples.find(s => now - s.at >= DAY_MS - 3_600_000 && now - s.at <= 2 * DAY_MS);
  const last = samples[samples.length - 1];
  if (value !== null && (!last || now - last.at >= SAMPLE_GAP_MS)) {
    samples = [...samples, { at: now, value }].filter(s => now - s.at <= 2 * DAY_MS);
    try { store.setItem(`goal-metric:${key}`, JSON.stringify(samples)); } catch { /* quota or private mode */ }
  }
  return baseline?.value ?? null;
}

const generatedAtOf = (d: unknown): string | null => {
  if (!d || typeof d !== 'object' || !('generatedAt' in d)) return null;
  const value = d.generatedAt;
  return typeof value === 'string' && value !== '' ? value : null;
};

/**
 * The reads and binding behind the metric column: merge speed + DIRTY backlog
 * count through `bindGoalMetrics`. Unknown stays unknown — a goal whose
 * metric has no reading is never shown as 0. `enabled` gates both fetches.
 */
export function useGoalMetrics(goals: readonly GoalSummary[] | undefined, enabled: boolean): Record<string, Metric> {
  const merges = useQuery(fleetMergesQuery, { enabled });
  const backlog = useQuery(mergeBacklogQuery, { enabled });
  return useMemo(() => {
    const readings: Partial<Record<GoalMetricId, MetricReading>> = {};
    const now = Date.now();
    if (merges.data !== undefined) {
      const value = readMergeSpeed(merges.data).perHour;
      readings['merges-per-hour'] = { value, observedAt: generatedAtOf(merges.data), previous24h: previousDayValue('merges-per-hour', value, now) };
    }
    if (backlog.data?.source === 'ok') {
      const value = backlog.data.counts.mergeState.DIRTY ?? 0;
      readings['open-dirty-prs'] = { value, observedAt: generatedAtOf(backlog.data), previous24h: previousDayValue('open-dirty-prs', value, now) };
    }
    return bindGoalMetrics(openGoals(goals ?? []), readings, now);
  }, [goals, merges.data, backlog.data]);
}
