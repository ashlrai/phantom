import { readGeneratorYield } from '../queue/generator-yield.js';
import { readGoals } from './goals.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { join } from 'node:path';
import { readLeverageReport } from '../metrics/leverage-class.js';
import { readTail, runsRoot, type LoopReleases } from '../metrics/loop-collect.js';
import { buildLoopStages, LOOP_STAGES_DEFAULT_SINCE_MS } from '../metrics/loop-stages.js';
import { readJobYield, readMetricsSeries } from './metrics-series.js';
import { metricsReader, readMetrics } from './metrics-glance.js';
import { readLiveStops, stopFilePath, stoppedFamilies } from './stop-file.js';

export interface MetricsPanelLoop {
  /** Stage window in ms; default 24 hours. */
  sinceMs?: number;
  /** The release list for merged to released. Absent means no release list was read, and the card says so. */
  releases?: (now: number) => Promise<LoopReleases>;
}

/** The dispatcher rollup covers jobs launched in the last 24 hours. */
export async function readMetricsPanel(runsDir = runsRoot(), now = Date.now(), stopFile = stopFilePath(), loop: MetricsPanelLoop = {}) {
  const jobs = join(runsDir, 'metrics', 'jobs.jsonl');
  const [goals, status, generatorYield, series, glance, jobYield, stops, ledger, loopReleases] = await Promise.all([readGoals(runsDir), readFleetRunsDirState({ runsDir }), readGeneratorYield(runsDir), readMetricsSeries(jobs, now),
    readMetrics({ now, reader: metricsReader(runsDir) }), readJobYield(jobs, 24, now, undefined, true), readLiveStops(stopFile, now), readTail(jobs, 16 * 1024 * 1024),
    loop.releases ? loop.releases(now) : Promise.resolve<LoopReleases>({ releases: null, reason: 'No release list was read for this report' })]);
  const names = new Set([...goals.lanes.map(row => row.lane), ...status.lanes.map(row => row.lane)]);
  return {
    schema: 'fleet.metrics-panel.v1' as const,
    observedAt: goals.observedAt,
    /** The `phm metrics` report: the four headline numbers, lanes and spend-down. */
    glance,
    generatorYield,
    /** The `phm jobs yield` report: which job kinds are worth a launch slot. */
    jobYield,
    /** Live rows of the job stop file, soonest to expire first. Null when the file is unknown. */
    stopped: stops && stoppedFamilies(stops, now).sort((a, b) => a.until - b.until),
    /** The `phm metrics leverage` report: merges per class per hour, from job ids only (no PR titles here). */
    leverage: readLeverageReport({ runsDir, now }),
    /** The `phm metrics loop` stage times, with releases read through the same reader as the CLI. */
    loopStages: buildLoopStages(ledger, loopReleases.releases, now, loop.sinceMs ?? LOOP_STAGES_DEFAULT_SINCE_MS, loopReleases.reason),
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
