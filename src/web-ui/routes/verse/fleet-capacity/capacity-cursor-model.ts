/**
 * Pure helpers for reading the Capacity board one sample at a time. Every chart on the board is drawn from the same
 * samples, so one sample index names the same moment on all of them: what a lane held then, what the fleet held then,
 * and where that moment sits on a chart or on the window strip. Nothing is interpolated between samples, and a lane
 * a sample does not name is "not reported", never zero.
 */
import type { RunsSample } from '../../../../core/fleet/runs-history.js';

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface LaneMoment { running: number; target: number; queued: number; held: boolean }
export interface FleetMoment { lanes: number; running: number; target: number; queued: number; held: number; paused: boolean | null }

/** The sample taken nearest to `atMs`; the later one on a tie. -1 when there is none. */
export function nearestSample(points: readonly { atMs: number }[], atMs: number): number {
  let best = -1, distance = Infinity;
  points.forEach((point, index) => {
    const away = Math.abs(point.atMs - atMs);
    if (away <= distance) { best = index; distance = away; }
  });
  return best;
}

/** Where a key moves the sample being read; null for a key the chart does not take. Page keys move a tenth of the window. */
export function stepSample(key: string, index: number, samples: number): number | null {
  if (samples === 0) return null;
  const page = Math.max(1, Math.round(samples / 10));
  const clamp = (to: number) => Math.min(samples - 1, Math.max(0, to));
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clamp(index - 1);
  if (key === 'ArrowRight' || key === 'ArrowUp') return clamp(index + 1);
  if (key === 'PageDown') return clamp(index - page);
  if (key === 'PageUp') return clamp(index + page);
  if (key === 'Home') return 0;
  if (key === 'End') return samples - 1;
  return null;
}

/** What one sample says about one lane; null when the sample does not name the lane. */
export function laneMoment(sample: RunsSample | undefined, lane: string): LaneMoment | null {
  const row = sample?.lanes.find((item) => item.lane === lane);
  return row ? { running: row.running, target: row.target, queued: row.queued, held: row.held } : null;
}

/** "18 of 24 running, 8 queued, held". A lane with no target says so instead of "of 0". */
export function laneMomentWords(moment: LaneMoment | null): string {
  if (!moment) return 'not reported in this sample';
  const running = moment.target > 0 ? `${moment.running.toLocaleString()} of ${moment.target.toLocaleString()} running` : `${moment.running.toLocaleString()} running, no target`;
  return `${running}, ${moment.queued.toLocaleString()} queued${moment.held ? ', held' : ''}`;
}

/** One sample across every lane it names. */
export function fleetMoment(sample: RunsSample): FleetMoment {
  const moment: FleetMoment = { lanes: sample.lanes.length, running: 0, target: 0, queued: 0, held: 0, paused: sample.paused };
  for (const lane of sample.lanes) {
    moment.running += lane.running;
    moment.target += lane.target;
    moment.queued += lane.queued;
    if (lane.held) moment.held += 1;
  }
  return moment;
}

/** "21 of 30 slots running across 3 lanes, 8 queued, 1 lane held, fleet paused". */
export function fleetMomentWords(moment: FleetMoment): string {
  if (moment.lanes === 0) return `no lane reported${moment.paused === true ? ', fleet paused' : ''}`;
  const slots = moment.target > 0 ? `${moment.running.toLocaleString()} of ${count(moment.target, 'slot', 'slots')} running` : `${moment.running.toLocaleString()} running, no target`;
  return `${slots} across ${count(moment.lanes, 'lane', 'lanes')}, ${moment.queued.toLocaleString()} queued${moment.held ? `, ${count(moment.held, 'lane', 'lanes')} held` : ''}${moment.paused === true ? ', fleet paused' : ''}`;
}

/** The worker and leader processes one sample counted; a count the sample lacks is unknown. */
export function processWords(sample: RunsSample | undefined): string {
  if (!sample) return 'not reported in this sample';
  const workers = sample.workers === null ? 'workers unknown' : count(sample.workers, 'worker', 'workers');
  const leaders = sample.leaders === null ? 'leaders unknown' : count(sample.leaders, 'leader', 'leaders');
  return `${workers}, ${leaders}`;
}

/** A sample in full, for a chart's slider: "Sample 3 of 7, Nov 20, 3:40 PM: 18 of 24 running, 8 queued". */
export function sampleWords(index: number, samples: number, time: string, words: string): string {
  return `Sample ${(index + 1).toLocaleString()} of ${samples.toLocaleString()}, ${time}: ${words}`;
}

/** Where a sample sits across a chart drawn from the first sample to the last, 0 to 100. */
export function sampleX(points: readonly { atMs: number }[], index: number): number | null {
  const point = points[index];
  if (!point || !points.length) return null;
  const start = points[0].atMs;
  const total = points[points.length - 1].atMs - start;
  return total > 0 ? Math.min(100, Math.max(0, (point.atMs - start) / total * 100)) : 0;
}
