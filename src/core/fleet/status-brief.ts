/**
 * `phm status --brief --json` and the phone's four tiles: is the fleet doing well, in four numbers.
 * One typed read shared by agents and the phone. It adds no data source: merge counts and the
 * median come from `phm metrics`, main health from the main-guardian glance, runway from
 * `phm pool runway`. Anything a source could not read stays null (unknown), never 0.
 */
import { readGuardianGlance, type GuardianGlanceRow } from './guardian-glance.js';
import { readMetrics, metricsReader, type MetricsReport } from './metrics-glance.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { readPoolRunway, runwayStatusPath } from '../usage/runway-read.js';
import { runwayHours, type RunwaySnapshot } from '../usage/runway.js';
import { readWhyIdle } from './why-idle-read.js';
import { FLEET_BRIEF_SCHEMA, type FleetBrief } from './status-brief-types.js';

export { FLEET_BRIEF_SCHEMA, type FleetBrief } from './status-brief-types.js';

export interface FleetBriefInputs {
  metrics: Pick<MetricsReport, 'merged' | 'merged_per_hour' | 'median_publish_to_merge_s'> | null;
  guardian: readonly Pick<GuardianGlanceRow, 'repo' | 'state'>[] | null;
  runway: Pick<RunwaySnapshot, 'pools'> | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Pure: the four numbers from the three existing readings. */
export function buildFleetBrief(input: FleetBriefInputs, now: number): FleetBrief {
  const m = input.metrics;
  const median = m?.median_publish_to_merge_s ?? null;
  const rows = input.guardian && input.guardian.length > 0 ? input.guardian : null;
  const pools = input.runway?.pools.filter(p => p.state !== 'unknown') ?? [];
  const running = pools.filter(p => p.hoursToEmpty !== null).sort((a, b) => a.hoursToEmpty! - b.hoursToEmpty! || a.pool.localeCompare(b.pool));
  const soonest = running[0];
  return {
    schema: FLEET_BRIEF_SCHEMA, v: 1, asOf: new Date(now).toISOString(),
    merged: { lastHour: m?.merged_per_hour.last_1h ?? null, last24h: m?.merged ?? null },
    medianMergeMinutes: median === null ? null : round1(median / 60),
    main: rows
      ? { green: rows.filter(r => r.state === 'green').length, total: rows.length, red: rows.filter(r => r.state === 'red').map(r => r.repo) }
      : { green: null, total: null, red: [] },
    runway: soonest
      ? { state: 'known', pool: soonest.pool, hoursLeft: round1(soonest.hoursToEmpty!),
        beforeReset: soonest.hoursToReset === null ? null : soonest.hoursToEmpty! < soonest.hoursToReset }
      : { state: pools.length > 0 ? 'steady' : 'unknown', pool: null, hoursLeft: null, beforeReset: null },
  };
}

/** Read each source once. A source that fails leaves only its own reading unknown. */
export async function readFleetBrief(opts: { runsDir?: string; now?: number } = {}): Promise<FleetBrief> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const now = opts.now ?? Date.now();
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [metrics, guardian, runway, whyIdle] = await Promise.all([
    quiet(readMetrics({ now, reader: metricsReader(runsDir) })),
    quiet(readGuardianGlance(runsDir, now)),
    quiet(readPoolRunway(runwayStatusPath(runsDir), now)),
    readWhyIdle(runsDir, now),
  ]);
  return { ...buildFleetBrief({ metrics, guardian, runway }, now), whyIdle };
}

const known = (n: number | null, say: (n: number) => string): string => (n === null ? 'unknown' : say(n));

/** Idle reasons followed by four status lines for a terminal. */
export function briefText(b: FleetBrief): string[] {
  return [
    ...(b.whyIdle ?? []),
    `Merged: ${known(b.merged.lastHour, n => `${n} in the last hour`)}, ${known(b.merged.last24h, n => `${n} in 24 hours`)}.`,
    `Typical time to merge: ${known(b.medianMergeMinutes, n => `${n} min`)}.`,
    `Main green: ${b.main.green === null ? 'unknown' : `${b.main.green} of ${b.main.total}`}${b.main.red.length ? ` (red: ${b.main.red.join(', ')})` : ''}.`,
    `Plan runs out first: ${b.runway.state === 'unknown' ? 'unknown' : b.runway.state === 'steady' ? 'none running down' : `${b.runway.pool} in ${runwayHours(b.runway.hoursLeft!)}`}.`,
  ];
}
