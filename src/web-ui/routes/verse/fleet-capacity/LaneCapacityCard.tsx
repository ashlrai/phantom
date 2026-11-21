/**
 * One lane on the Capacity board: provider mark and name (opens Lanes), its fill as the figure, the running line
 * against the dashed target with held and paused bands, the time and value scale, labelled readings, then the
 * lines other reads add (models, hold reason, lane truth). Also the chart and the readings list the pane reuses.
 */
import type { ReactNode } from 'react';
import type { RunsSample } from '../../../../core/fleet/runs-history.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { areaPath, laneFacts, peak, type BoardFact } from './capacity-board-model.js';
import { MAX_GAP_MS, sparkPath, type LaneSeries, type SparkPoint } from './capacity-model.js';
import styles from './fleet-capacity.module.css';

const WIDTH = 240;
const HEIGHT = 48;
const format = (n: number) => Number(n.toFixed(1)).toLocaleString();
const percent = (n: number | null) => n === null ? '—' : `${format(n)}%`;
export const clock = (ms: number): string => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** `samples` must be in time order. */
export function CapacityChart({ points, samples, held, label, unit }: { points: SparkPoint[]; samples: RunsSample[]; held?: string; label: string; unit: string }) {
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
  return <figure className={styles.figure}>
    <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {bands}<path d={areaPath(points, WIDTH, HEIGHT)} className={styles.area} /><path d={paths.target} className={styles.target} /><path d={paths.running} className={styles.running} />
      {points.length === 1 && points[0].running !== null ? <circle cx="0" cy={HEIGHT - points[0].running / Math.max(1, points[0].running, points[0].target ?? 0) * HEIGHT} r="2" className={styles.dot} /> : null}
    </svg>
    {/* The scale the lines are drawn on: when the first and last sample were taken, and what the top edge is worth. */}
    {points.length > 0 ? <figcaption className={styles.axis}><time dateTime={new Date(start).toISOString()}>{clock(start)}</time><span>top edge {peak(points)} {unit}</span><time dateTime={new Date(end).toISOString()}>{clock(end)}</time></figcaption> : null}
  </figure>;
}

export function Facts({ facts, label }: { facts: readonly BoardFact[]; label: string }) {
  return <dl className={styles.facts} aria-label={label}>{facts.map((fact) => <div key={fact.label} className={styles.fact} data-tone={fact.tone} data-testid={fact.testId}>
    <dt>{fact.label}</dt><dd>{fact.value}</dd>{fact.note ? <dd className={styles.note}>{fact.note}</dd> : null}
  </div>)}</dl>;
}

export function LaneCapacityCard({ lane, samples, onOpen, children }: { lane: LaneSeries; samples: RunsSample[]; onOpen: () => void; children?: ReactNode }) {
  const points = samples.map((sample) => {
    const value = sample.lanes.find((item) => item.lane === lane.lane);
    return { atMs: Date.parse(sample.at), running: value?.running ?? null, target: value?.target ?? null };
  });
  return <li className={styles.lane} data-board-card data-tone={lane.stallMinutes > 0 ? 'warning' : undefined}>
    <div className={styles.line}>
      <ProviderBadge of={lane.lane} iconOnly size={14} />
      <strong><button type="button" className={styles.laneButton} aria-label={`Open ${lane.lane} in Lanes`} onClick={onOpen}>{lane.lane}</button></strong>
      <span className={styles.figureValue}><b>{lane.fillPct === null ? 'no target' : percent(lane.fillPct)}</b>{lane.fillPct === null ? '' : ' of target'}</span>
    </div>
    <CapacityChart points={points} samples={samples} held={lane.lane} unit="slots" label={`${lane.lane}: ran at ${percent(lane.fillPct)} of target, ${format(lane.idleSlotMinutes)} idle slot-minutes`} />
    <Facts facts={laneFacts(lane)} label={`${lane.lane} readings`} />
    {children}
  </li>;
}
