/**
 * Pure arithmetic for the Capacity board: fleet totals, the order of the lane cards, each card's labelled readings,
 * when the sampler was watching, and the filled area under a running line. Everything is derived from the samples
 * GET /api/verse/runs-history returned; nothing is estimated for the time nobody watched.
 */
import { MAX_GAP_MS, type LaneSeries, type SparkPoint } from './capacity-model.js';

const MINUTE = 60_000;
const round = (n: number) => Number(n.toFixed(1)).toLocaleString();

export interface BoardFact { label: string; value: string; note?: string; tone?: 'warning'; testId?: string }
export interface BoardTotals { fillPct: number | null; idleSlotMinutes: number; heldMinutes: number; stallMinutes: number }
export interface Segment { fromMs: number; toMs: number }

/** Minutes as words: minutes under two hours, hours after. */
export function span(minutes: number): string {
  return minutes < 120 ? `${round(minutes)} min` : `${round(minutes / 60)} h`;
}
/** Idle capacity is slots times time, so it keeps its own unit. */
export function slotSpan(slotMinutes: number): string {
  return slotMinutes < 120 ? `${round(slotMinutes)} slot-min` : `${round(slotMinutes / 60)} slot-h`;
}

/** Fill is running over target across every sample of every lane: the same sampled share each card shows. */
export function fleetTotals(lanes: readonly LaneSeries[]): BoardTotals {
  let running = 0;
  let target = 0;
  const totals: BoardTotals = { fillPct: null, idleSlotMinutes: 0, heldMinutes: 0, stallMinutes: 0 };
  for (const lane of lanes) {
    for (const point of lane.points) { running += point.running; target += point.target; }
    totals.idleSlotMinutes += lane.idleSlotMinutes;
    totals.heldMinutes += lane.heldMinutes;
    totals.stallMinutes += lane.stallMinutes;
  }
  totals.fillPct = target ? running / target * 100 : null;
  return totals;
}

/** The fleet's fill as the board writes it; a window with no target has no percentage. */
export const fillText = (totals: BoardTotals): string => totals.fillPct === null ? 'no target' : `${round(totals.fillPct)}%`;

export function boardHeadline(totals: BoardTotals, laneCount: number): string {
  if (laneCount === 0) return 'No lanes reported in this window';
  if (totals.fillPct === null) return 'No lane had a target in this window';
  return `Lanes filled ${round(totals.fillPct)}% of their target slots`;
}

/** Lanes that waited with work queued come first, then the most idle capacity, then by name. */
export function rankLanes(lanes: readonly LaneSeries[]): LaneSeries[] {
  return [...lanes].sort((a, b) => b.stallMinutes - a.stallMinutes || b.idleSlotMinutes - a.idleSlotMinutes || a.lane.localeCompare(b.lane));
}

/** Stretches of time with samples no more than five minutes apart: when the sampler was actually watching. */
export function watchedSegments(times: readonly number[]): Segment[] {
  const out: Segment[] = [];
  for (const at of [...times].filter(Number.isFinite).sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && at - last.toMs <= MAX_GAP_MS) last.toMs = at;
    else out.push({ fromMs: at, toMs: at });
  }
  return out;
}
export const watchedMinutes = (segments: readonly Segment[]): number => segments.reduce((sum, segment) => sum + (segment.toMs - segment.fromMs), 0) / MINUTE;

/** Where a stretch sits on a strip that runs from `fromMs` to `toMs`, as percentages clamped to the strip. */
export function place(segment: Segment, fromMs: number, toMs: number): { left: number; width: number } {
  const total = Math.max(1, toMs - fromMs);
  const left = Math.min(100, Math.max(0, (segment.fromMs - fromMs) / total * 100));
  const right = Math.min(100, Math.max(0, (segment.toMs - fromMs) / total * 100));
  return { left, width: Math.max(0, right - left) };
}

export function totalFacts(totals: BoardTotals, watched: number, hours: number): BoardFact[] {
  return [
    { label: 'Filled', value: fillText(totals), note: 'running over target, by sample' },
    { label: 'Idle', value: slotSpan(totals.idleSlotMinutes), note: 'open slots over time' },
    { label: 'Held', value: span(totals.heldMinutes), note: 'lane time on hold' },
    { label: 'Stalled', value: span(totals.stallMinutes), note: 'open slots with work queued', tone: totals.stallMinutes > 0 ? 'warning' : undefined },
    { label: 'Watched', value: span(watched), note: `of the last ${hours} h` },
  ];
}

export function laneFacts(lane: LaneSeries): BoardFact[] {
  const last = lane.points[lane.points.length - 1];
  const facts: BoardFact[] = [];
  if (last) facts.push({ label: 'Last sample', value: `${last.running} of ${last.target}`, note: `${last.queued} queued${last.held ? ' · held' : ''}` });
  facts.push({ label: 'Idle', value: slotSpan(lane.idleSlotMinutes) }, { label: 'Held', value: span(lane.heldMinutes) });
  if (lane.stallMinutes > 0) facts.push({ label: 'Stalled', value: span(lane.stallMinutes), tone: 'warning', testId: 'lane-stalled' });
  return facts;
}

/** The top of a chart's value scale: the largest running or target reading, at least one. */
export const peak = (points: readonly SparkPoint[]): number => Math.max(1, ...points.flatMap((point) => [point.running ?? 0, point.target ?? 0]));

/** Closed shapes under the running line, on the scale sparkPath uses. A missing reading or a long break ends a shape. */
export function areaPath(points: readonly SparkPoint[], width: number, height: number): string {
  if (!points.length) return '';
  const start = points[0].atMs;
  const total = Math.max(1, points[points.length - 1].atMs - start);
  const max = peak(points);
  const shapes: string[] = [];
  let run: SparkPoint[] = [];
  const x = (point: SparkPoint) => ((point.atMs - start) / total * width).toFixed(2);
  const close = () => {
    if (run.length > 1) shapes.push(`M${x(run[0])},${height} ${run.map((point) => `L${x(point)},${(height - point.running! / max * height).toFixed(2)}`).join(' ')} L${x(run[run.length - 1])},${height} Z`);
    run = [];
  };
  for (const point of points) {
    if (point.running === null) { close(); continue; }
    if (run.length && point.atMs - run[run.length - 1].atMs > MAX_GAP_MS) close();
    run.push(point);
  }
  close();
  return shapes.join(' ');
}
