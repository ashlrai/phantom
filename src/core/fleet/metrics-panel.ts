import { readGeneratorYield } from '../queue/generator-yield.js';
import { readGoals } from './goals.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { join } from 'node:path';
import { runsRoot } from '../metrics/loop-collect.js';
import { readMetricsSeries } from './metrics-series.js';
import { metricsReader, readMetrics } from './metrics-glance.js';

/** The dispatcher rollup covers jobs launched in the last 24 hours. */
export async function readMetricsPanel(runsDir = runsRoot(), now = Date.now()) {
  const [goals, status, generatorYield, series, glance] = await Promise.all([readGoals(runsDir), readFleetRunsDirState({ runsDir }), readGeneratorYield(runsDir), readMetricsSeries(join(runsDir, 'metrics', 'jobs.jsonl'), now),
    readMetrics({ now, reader: metricsReader(runsDir) })]);
  const names = new Set([...goals.lanes.map(row => row.lane), ...status.lanes.map(row => row.lane)]);
  return {
    schema: 'fleet.metrics-panel.v1' as const,
    observedAt: goals.observedAt,
    /** The `phm metrics` report: the four headline numbers, lanes and spend-down. */
    glance,
    generatorYield,
    series,
    hourlyMerges: series.known ? series.hours.map(hour => hour.merged!) : null,
    lanes: [...names].sort().map(lane => {
      const metric = goals.lanes.find(row => row.lane === lane);
      const slot = status.lanes.find(row => row.lane === lane);
      return { lane, mergesPerHour: metric?.mergesPerHour ?? null,
        medianOpenToMergeSeconds: metric?.medianOpenToMergeSeconds ?? null,
        emptyRate: metric?.emptyRate ?? null, running: slot?.running ?? null, target: slot?.target ?? null };
    }),
  };
}
export type MetricsPanel = Awaited<ReturnType<typeof readMetricsPanel>>;
