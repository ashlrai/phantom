/**
 * One lane on the Capacity board: provider mark and name (opens Lanes), its fill as the figure, the running line
 * against the dashed target with held and paused bands, the time and value scale, labelled readings, then the
 * lines other reads add (models, hold reason, lane truth). Also the chart and the readings list the pane reuses.
 *
 * A chart given a cursor can be read one sample at a time: pointing at it picks the sample taken nearest, and with
 * the chart focused Left and Right step through the samples (Page Up and Page Down a tenth of the window, Home and
 * End the ends, Esc lets go). The cursor belongs to the board, so every chart marks the same moment.
 */
import { memo, useMemo, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { RunsSample } from '../../../../core/fleet/runs-history.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { areaPath, laneFacts, peak, type BoardFact } from './capacity-board-model.js';
import { laneMoment, laneMomentWords, nearestSample, sampleWords, sampleX, stepSample } from './capacity-cursor-model.js';
import { MAX_GAP_MS, sparkPath, type LaneSeries, type SparkPoint } from './capacity-model.js';
import styles from './fleet-capacity.module.css';

const WIDTH = 240;
const HEIGHT = 48;
const format = (n: number) => Number(n.toFixed(1)).toLocaleString();
const percent = (n: number | null) => n === null ? '—' : `${format(n)}%`;
export const clock = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The sample the board is reading (its place in the samples, or null) and how a chart changes it. */
export interface BoardCursor { index: number | null; pick: (index: number | null) => void }
/** A chart's share of the cursor: its slider name and what it says for one sample. */
export interface ChartCursor extends BoardCursor { name: string; words: (index: number) => string }

// Every chart's slider carries this mark, so a pointer leaving one chart does not let go of a sample another chart holds
// by keyboard, and Tab from one chart to the next keeps the moment being read.
const isScrub = (node: unknown): boolean => node instanceof HTMLElement && node.dataset.scrub === 'capacity';
const holdsFocus = () => isScrub(document.activeElement);

/** The drawn lines. Kept apart from the cursor so moving it redraws no path. `samples` must be in time order. */
const ChartLines = memo(function ChartLines({ points, samples, held, label }: { points: SparkPoint[]; samples: RunsSample[]; held?: string; label: string }) {
  const start = points[0]?.atMs ?? 0;
  const end = points[points.length - 1]?.atMs ?? start;
  const total = Math.max(1, end - start);
  const paths = sparkPath(points, WIDTH, HEIGHT);
  const bands = samples.flatMap((sample, i) => {
    const at = Date.parse(sample.at);
    const next = samples[i + 1] ? Date.parse(samples[i + 1].at) : at;
    const duration = Math.min(MAX_GAP_MS, Math.max(0, next - at));
    if (!duration) return [];
    const x = (at - start) / total * WIDTH;
    const width = duration / total * WIDTH;
    return [sample.paused === true ? <rect key={`pause-${i}`} x={x} y="0" width={width} height={HEIGHT} className={styles.paused} /> : null,
      held && sample.lanes.some((lane) => lane.lane === held && lane.held) ? <rect key={`held-${i}`} x={x} y="0" width={width} height={HEIGHT} className={styles.held} /> : null];
  });
  return <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {bands}<path d={areaPath(points, WIDTH, HEIGHT)} className={styles.area} /><path d={paths.target} className={styles.target} /><path d={paths.running} className={styles.running} />
    {points.length === 1 && points[0].running !== null ? <circle cx="0" cy={HEIGHT - points[0].running / Math.max(1, points[0].running, points[0].target ?? 0) * HEIGHT} r="2" className={styles.dot} /> : null}
  </svg>;
});

/** `samples` must be in time order, with one point per sample. */
export function CapacityChart({ points, samples, held, label, unit, cursor }: { points: SparkPoint[]; samples: RunsSample[]; held?: string; label: string; unit: string; cursor?: ChartCursor }) {
  const start = points[0]?.atMs ?? 0;
  const end = points[points.length - 1]?.atMs ?? start;
  const count = points.length;
  // One sample has nothing to step between; a cursor past the samples (a shorter window just arrived) marks nothing.
  const scrub = cursor && count > 1 ? cursor : null;
  const index = scrub && scrub.index !== null && scrub.index < count ? scrub.index : null;
  const x = index === null ? null : sampleX(points, index);
  const mark = index === null ? null : points[index];

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!scrub || !(box.width > 0)) return;
    const near = nearestSample(points, start + (event.clientX - box.left) / box.width * (end - start));
    if (near >= 0) scrub.pick(near);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!scrub) return;
    if (event.key === 'Escape') {
      // Esc lets go of the sample first; a second Esc is the pane's.
      if (index !== null) { event.stopPropagation(); scrub.pick(null); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = stepSample(event.key, index ?? count - 1, count);
    if (next === null) return;
    event.preventDefault();
    scrub.pick(next);
  };
  const shown = index ?? count - 1;

  return <figure className={styles.figure}>
    <div className={styles.plot}>
      <ChartLines points={points} samples={samples} held={held} label={label} />
      {x !== null && mark ? <>
        <span className={styles.rule} data-rule="picked" style={{ left: `${x}%` }} />
        {/* An HTML ring: a circle inside the stretched plot would be drawn as an ellipse. No reading, no ring. */}
        {mark.running === null ? null : <span className={styles.ring} data-point="picked" style={{ left: `${x}%`, bottom: `${mark.running / peak(points) * 100}%` }} />}
      </> : null}
      {/* Over the whole plot and last, so it takes the pointer. A slider: one value per sample, said in full. */}
      {scrub ? <div className={styles.scrub} role="slider" tabIndex={0} data-scrub="capacity" aria-label={scrub.name} aria-orientation="horizontal"
        aria-valuemin={1} aria-valuemax={count} aria-valuenow={shown + 1} aria-valuetext={sampleWords(shown, count, clock(points[shown].atMs), scrub.words(shown))}
        onPointerMove={point} onPointerDown={point} onPointerLeave={() => { if (!holdsFocus()) scrub.pick(null); }}
        onFocus={() => { if (index === null) scrub.pick(count - 1); }} onBlur={(event) => { if (!isScrub(event.relatedTarget)) scrub.pick(null); }} onKeyDown={key} /> : null}
    </div>
    {/* While a sample is read the scale line gives way to it: when it was taken and what this chart held then.
        Otherwise the scale the lines are drawn on: when the first and last sample were taken, and what the top edge is worth. */}
    {scrub && index !== null && mark ? <figcaption className={styles.axis} data-reading={index + 1}><time dateTime={new Date(mark.atMs).toISOString()}>{clock(mark.atMs)}</time><span>{scrub.words(index)}</span></figcaption>
      : points.length > 0 ? <figcaption className={styles.axis}><time dateTime={new Date(start).toISOString()}>{clock(start)}</time><span>top edge {peak(points)} {unit}</span><time dateTime={new Date(end).toISOString()}>{clock(end)}</time></figcaption> : null}
  </figure>;
}

export function Facts({ facts, label }: { facts: readonly BoardFact[]; label: string }) {
  return <dl className={styles.facts} aria-label={label}>{facts.map((fact) => <div key={fact.label} className={styles.fact} data-tone={fact.tone} data-testid={fact.testId}>
    <dt>{fact.label}</dt><dd>{fact.value}</dd>{fact.note ? <dd className={styles.note}>{fact.note}</dd> : null}
  </div>)}</dl>;
}

export function LaneCapacityCard({ lane, samples, onOpen, cursor, children }: { lane: LaneSeries; samples: RunsSample[]; onOpen: () => void; cursor?: BoardCursor; children?: ReactNode }) {
  const name = lane.lane;
  const points = useMemo(() => samples.map((sample) => {
    const value = sample.lanes.find((item) => item.lane === name);
    return { atMs: Date.parse(sample.at), running: value?.running ?? null, target: value?.target ?? null };
  }), [samples, name]);
  const read: ChartCursor | undefined = cursor && { ...cursor, name: `${name} samples`, words: (index) => laneMomentWords(laneMoment(samples[index], name)) };
  return <li className={styles.lane} data-tone={lane.stallMinutes > 0 ? 'warning' : undefined}>
    <div className={styles.line}>
      <ProviderBadge of={lane.lane} iconOnly size={14} />
      <strong><button type="button" className={styles.laneButton} aria-label={`Open ${lane.lane} in Lanes`} onClick={onOpen}>{lane.lane}</button></strong>
      <span className={styles.figureValue}><b>{lane.fillPct === null ? 'no target' : percent(lane.fillPct)}</b>{lane.fillPct === null ? '' : ' of target'}</span>
    </div>
    <CapacityChart points={points} samples={samples} held={lane.lane} unit="slots" cursor={read} label={`${lane.lane}: ran at ${percent(lane.fillPct)} of target, ${format(lane.idleSlotMinutes)} idle slot-minutes`} />
    <Facts facts={laneFacts(lane)} label={`${lane.lane} readings`} />
    {children}
  </li>;
}
