import type { RunsHistory, RunsSample } from '../../../../core/fleet/runs-history.js';
import { isNoFleet, NO_FLEET_TEXT } from '../fleet/no-fleet.js';

const MINUTE = 60_000;
export const MAX_GAP_MS = 5 * MINUTE;
export interface LanePoint { atMs: number; running: number; target: number; queued: number; held: boolean }
export interface LaneSeries { lane: string; points: LanePoint[]; fillPct: number | null; idleSlotMinutes: number; heldMinutes: number }
export interface SparkPoint { atMs: number; running: number | null; target: number | null }

function ordered(history: RunsHistory): RunsSample[] {
  return [...history.samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function laneSeries(history: RunsHistory, now: number): LaneSeries[] {
  const samples = ordered(history).filter((sample) => Date.parse(sample.at) >= Date.parse(history.from) && Date.parse(sample.at) <= Math.min(now, Date.parse(history.to)));
  const lanes = new Map<string, LaneSeries>();
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const atMs = Date.parse(sample.at);
    const minutes = i + 1 < samples.length ? Math.min(MAX_GAP_MS, Math.max(0, Date.parse(samples[i + 1].at) - atMs)) / MINUTE : 0;
    for (const lane of sample.lanes) {
      let series = lanes.get(lane.lane);
      if (!series) {
        series = { lane: lane.lane, points: [], fillPct: null, idleSlotMinutes: 0, heldMinutes: 0 };
        lanes.set(lane.lane, series);
      }
      series.points.push({ atMs, running: lane.running, target: lane.target, queued: lane.queued, held: lane.held });
      series.idleSlotMinutes += Math.max(0, lane.target - lane.running) * minutes;
      if (lane.held) series.heldMinutes += minutes;
    }
  }
  for (const series of lanes.values()) {
    const total = series.points.reduce((sum, point) => ({ running: sum.running + point.running, target: sum.target + point.target }), { running: 0, target: 0 });
    series.fillPct = total.target ? total.running / total.target * 100 : null;
  }
  return [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
}

function allLaunchGaps(history: RunsHistory): Array<{ fromMs: number; toMs: number; minutes: number }> {
  const samples = ordered(history);
  const gaps: Array<{ fromMs: number; toMs: number; minutes: number }> = [];
  let start: number | null = null;
  const finish = (end: number) => {
    if (start !== null && end - start >= 30 * MINUTE) gaps.push({ fromMs: start, toMs: end, minutes: (end - start) / MINUTE });
    start = null;
  };
  const signature = (sample: RunsSample) => JSON.stringify(sample.lanes.map(({ lane, running }) => [lane, running]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i];
    const at = Date.parse(current.at);
    const queued = current.lanes.some((lane) => lane.queued > 0);
    if (!queued) { if (i > 0) finish(Date.parse(samples[i - 1].at)); continue; }
    if (start === null) { start = at; continue; }
    const previous = samples[i - 1];
    const previousAt = Date.parse(previous.at);
    if (at - previousAt > MAX_GAP_MS || signature(previous) !== signature(current)) {
      finish(previousAt);
      start = at;
    }
  }
  if (samples.length) finish(Date.parse(samples[samples.length - 1].at));
  return gaps.sort((a, b) => b.toMs - a.toMs);
}

export function launchGaps(history: RunsHistory): Array<{ fromMs: number; toMs: number; minutes: number }> {
  return allLaunchGaps(history).slice(0, 5);
}

export function headline(history: RunsHistory, now: number): string {
  if (!history.samples.length && isNoFleet(history.sourceState)) return NO_FLEET_TEXT;
  const quality = `${history.sourceState !== 'healthy' ? ` · source ${history.sourceState}` : ''}${history.dropped > 0 ? ` · ${history.dropped.toLocaleString()} dropped` : ''}`;
  if (!history.samples.length) return `No capacity history yet (the sampler starts when this pane is open)${quality}`;
  const hours = Math.max(0, (Date.parse(history.to) - Date.parse(history.from)) / (60 * MINUTE));
  const lanes = laneSeries(history, now).length;
  const gaps = allLaunchGaps(history);
  const longest = gaps.reduce((max, gap) => Math.max(max, gap.minutes), 0);
  return `${Number(hours.toFixed(1))} h · ${lanes} ${lanes === 1 ? 'lane' : 'lanes'} · ${history.samples.length.toLocaleString()} ${history.samples.length === 1 ? 'sample' : 'samples'} · ${gaps.length} launch ${gaps.length === 1 ? 'gap' : 'gaps'}${gaps.length ? ` (longest ${Math.round(longest)} min)` : ''}${quality}`;
}

/** Both lines share one time/value scale; missing readings and long watching gaps break lines. */
export function sparkPath(points: SparkPoint[], width: number, height: number): { running: string; target: string } {
  if (!points.length) return { running: '', target: '' };
  const start = points[0].atMs;
  const span = Math.max(1, points[points.length - 1].atMs - start);
  const max = Math.max(1, ...points.flatMap((point) => [point.running ?? 0, point.target ?? 0]));
  const path = (key: 'running' | 'target') => {
    let previous: SparkPoint | null = null;
    return points.map((point) => {
      const value = point[key];
      if (value === null) { previous = null; return ''; }
      const command = previous && point.atMs - previous.atMs <= MAX_GAP_MS ? 'L' : 'M';
      previous = point;
      return `${command}${((point.atMs - start) / span * width).toFixed(2)},${(height - value / max * height).toFixed(2)}`;
    }).filter(Boolean).join(' ');
  };
  return { running: path('running'), target: path('target') };
}
