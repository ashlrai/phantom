/** `phm fleet pulse --lanes`: what we optimize for, per lane and for the whole fleet, over the last 24 hours:
 * PRs merged per hour, median publish-to-merge time (the PR is open from publish), EMPTY rate and jobs running vs capacity.
 * Built only from readers other commands already use: the job metrics ledger by lane (`phm throughput --by lane`) and the
 * lane snapshot (`phm fleet lanes`) for running jobs and slot targets. `buildPulseLanes` is pure; the CLI and the desktop
 * and phone Pulse strip call it. Unknown stays null and says so, never 0; a quiet but readable ledger is real zeros. */
import { join } from 'node:path';
import { defaultRunsDir } from './landed-closes-read.js';
import { durationText, readThroughput, type ThroughputReport } from './throughput.js';
import { PULSE_LANES_SCHEMA, PULSE_WINDOW_H, type PulseLaneV1, type PulseLanesV1, type PulseSeriesV1 } from './pulse-lanes-types.js';

export { PULSE_LANES_SCHEMA, PULSE_WINDOW_H, type PulseLaneState, type PulseLaneV1, type PulseSeriesV1, type PulseLanesV1 } from './pulse-lanes-types.js';

export interface LaneSlotRead { lane: string; running: number | null; capacity: number | null }
/** Every reader's output as it returned it; null when that reader failed. */
export interface PulseLanesInputs { throughput: ThroughputReport | null; slots: LaneSlotRead[] | null }

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;
const sumKnown = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const percent = (rate: number | null): string => rate === null ? 'unknown' : `${Math.round(rate * 100)}%`;
const laneLine = (row: Omit<PulseLaneV1, 'line'>): string => {
  if (row.state === 'no_data') return 'no data yet';
  const slots = row.running === null && row.capacity === null ? 'jobs running unknown' : `${row.running ?? '?'} of ${row.capacity ?? '?'} running`;
  return `${row.merged} merged (${row.merged_per_h}/h), median ${durationText(row.median_open_to_merge_s)} to merge, EMPTY ${row.finished ? percent(row.empty_rate) : 'none finished'}, ${slots}`;
};

/** Pure: the pulse for these inputs at `now`. */
export function buildPulseLanes(inputs: PulseLanesInputs, now: number): PulseLanesV1 {
  const report = inputs.throughput?.metrics === 'ok' ? inputs.throughput : null;
  const hours = report?.hours ?? PULSE_WINDOW_H;
  const quiet = report !== null && ['launched', 'published', 'merged', 'finished'].every(k => (report.totals[k as 'launched'] ?? 0) === 0);
  const groups = new Map((report?.groups ?? []).map(group => [group.name, group]));
  const slots = new Map((inputs.slots ?? []).map(row => [row.lane, row]));
  const names = [...new Set([...groups.keys(), ...slots.keys()])].sort((a, b) => a.localeCompare(b));
  const lanes = names.map((lane): PulseLaneV1 => {
    const slot = slots.get(lane), group = groups.get(lane);
    const base = { lane, running: slot?.running ?? null, capacity: slot?.capacity ?? null };
    const measured = group ?? (quiet ? { totals: { merged: 0, finished: 0, empty_rate: null, median_publish_to_merge_s: null } } : null);
    const row = !measured ? { ...base, state: 'no_data' as const, merged_per_h: null, median_open_to_merge_s: null, empty_rate: null, merged: null, finished: null }
      : { ...base, state: group ? 'measured' as const : 'idle' as const, merged: measured.totals.merged, finished: measured.totals.finished,
        merged_per_h: measured.totals.merged === null ? null : round(measured.totals.merged / hours, 2),
        median_open_to_merge_s: measured.totals.median_publish_to_merge_s, empty_rate: measured.totals.empty_rate };
    return { ...row, line: laneLine(row) };
  });

  const t = report?.totals;
  const merged = t?.merged ?? null, finished = t?.finished ?? null;
  const series: PulseSeriesV1 = { merged_per_h: (report?.buckets ?? []).map(hour => hour.merged ?? 0),
    median_open_to_merge_s: (report?.buckets ?? []).map(hour => hour.median_publish_to_merge_s), empty_rate: (report?.buckets ?? []).map(hour => hour.empty_rate) };
  const totals: PulseLanesV1['totals'] = {
    running: sumKnown(lanes.map(l => l.running)), capacity: sumKnown(lanes.map(l => l.capacity)),
    merged_per_h: merged === null ? null : round(merged / hours, 2), median_open_to_merge_s: t?.median_publish_to_merge_s ?? null,
    empty_rate: t?.empty_rate ?? null, merged, finished, series,
  };
  const headline = !report ? 'Unknown: the job metrics file could not be read.'
    : quiet ? `Quiet: nothing was launched, published or merged in the last ${hours} hours.`
    : `${merged} PRs merged in the last ${hours} hours (${totals.merged_per_h}/h), median ${durationText(totals.median_open_to_merge_s)} to merge, EMPTY ${finished ? percent(totals.empty_rate) : 'none finished'}${
      totals.running === null ? '' : `, ${totals.running}${totals.capacity === null ? '' : ` of ${totals.capacity}`} running`}.`;
  return { schema: PULSE_LANES_SCHEMA, v: 1, as_of: new Date(now).toISOString(), window_h: hours, headline, lanes, totals };
}

/** Running jobs and slot targets per lane from the lane snapshot; null when it cannot be read. */
export async function readSlots(): Promise<LaneSlotRead[] | null> {
  const { getFleetLaneSnapshot } = await import('./lane-console.js');
  const snapshot = await getFleetLaneSnapshot();
  return snapshot.lanes.map(view => ({ lane: view.lane, running: view.liveJobs, capacity: view.slotTarget }));
}

/** Read every input once. Read-only; a reader that fails leaves its numbers unknown. */
export async function readPulseLanesInputs(runsDir: string, now: number, readSlotRows: () => Promise<LaneSlotRead[] | null> = readSlots): Promise<PulseLanesInputs> {
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [throughput, slots] = await Promise.all([
    quiet(readThroughput({ runsDir, now, hours: PULSE_WINDOW_H, by: 'lane', metricsPath: join(runsDir, 'metrics', 'jobs.jsonl') })),
    quiet(readSlotRows()),
  ]);
  return { throughput, slots };
}

export async function readPulseLanes(opts: { runsDir?: string; now?: number; read?: typeof readPulseLanesInputs } = {}): Promise<PulseLanesV1> {
  const now = opts.now ?? Date.now();
  return buildPulseLanes(await (opts.read ?? readPulseLanesInputs)(opts.runsDir ?? defaultRunsDir(), now), now);
}

/** Plain lines for a terminal: the headline, then one line per lane. */
export function pulseLanesText(pulse: PulseLanesV1): string[] {
  return [pulse.headline, ...pulse.lanes.map(lane => `  ${lane.lane}: ${lane.line}`)];
}
