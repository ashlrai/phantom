import { useMemo, useState } from 'react';
import type { RunsSample } from '../../../../core/fleet/runs-history.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { headline, laneSeries, launchGaps, MAX_GAP_MS, sparkPath, type SparkPoint } from './capacity-model.js';
import { runsHistoryQuery, type CapacityHours } from './capacity-queries.js';
import styles from './fleet-capacity.module.css';

const WIDTH = 240;
const HEIGHT = 48;
const format = (n: number) => Number(n.toFixed(1)).toLocaleString();
const percent = (n: number | null) => n === null ? '—' : `${format(n)}%`;

function Chart({ points, samples, held, label }: { points: SparkPoint[]; samples: RunsSample[]; held?: string; label: string }) {
  const sorted = [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const start = points[0]?.atMs ?? 0;
  const end = points[points.length - 1]?.atMs ?? start;
  const span = Math.max(1, end - start);
  const paths = sparkPath(points, WIDTH, HEIGHT);
  const bands = sorted.flatMap((sample, i) => {
    const at = Date.parse(sample.at);
    const next = sorted[i + 1] ? Date.parse(sorted[i + 1].at) : at;
    const duration = Math.min(MAX_GAP_MS, Math.max(0, next - at));
    if (!duration) return [];
    const x = (at - start) / span * WIDTH;
    const width = duration / span * WIDTH;
    return [sample.paused === true ? <rect key={`pause-${i}`} x={x} y="0" width={width} height={HEIGHT} className={styles.paused} /> : null,
      held && sample.lanes.some((lane) => lane.lane === held && lane.held) ? <rect key={`held-${i}`} x={x} y="0" width={width} height={HEIGHT} className={styles.held} /> : null];
  });
  return <svg className={styles.chart} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
    {bands}<path d={paths.target} className={styles.target} /><path d={paths.running} className={styles.running} />
    {points.length === 1 && points[0].running !== null ? <circle cx="0" cy={HEIGHT - points[0].running / Math.max(1, points[0].running, points[0].target ?? 0) * HEIGHT} r="2" className={styles.dot} /> : null}
  </svg>;
}

export function FleetCapacityPane({ visible }: Pick<PaneProps, 'visible'>) {
  const [hours, setHours] = useState<CapacityHours>(24);
  const query = useMemo(() => runsHistoryQuery(hours), [hours]);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(query, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(query);
  const refresh = useRefresh(query);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const now = Date.now();
  const samples = data ? [...data.samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const lanes = data ? laneSeries(data, now) : [];
  const gaps = data ? launchGaps(data) : [];
  const workerPoints = samples.map((sample) => ({ atMs: Date.parse(sample.at), running: sample.workers, target: sample.leaders }));

  return <div className={styles.pane} aria-label="Capacity">
    <header className={styles.header}>
      <p className={styles.headline}>{data ? headline(data, now) : 'Fleet capacity history'}</p>
      <button type="button" className={styles.button} onClick={refresh}>Refresh</button>
    </header>
    <div className={styles.controls} role="group" aria-label="History window">
      {([6, 24, 72] as const).map((value) => <button type="button" className={styles.button} aria-pressed={hours === value} key={value} onClick={() => setHours(value)}>{value} h</button>)}
    </div>
    {data === null ? <p className={styles.muted}>Capacity history has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Capacity history is unavailable.' : 'Reading capacity history…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Capacity history could not refresh. Showing the last reading.</p> : null}
        {samples.length > 0 ? <>
          <p className={styles.muted}>Solid: running · dashed: target · shaded: held · muted band: paused. Breaks indicate missing observations.</p>
          <p className={styles.muted}>Observed: {new Date(samples[0].at).toLocaleString()} – {new Date(samples[samples.length - 1].at).toLocaleString()}</p>
          <section className={styles.section} aria-labelledby="capacity-lanes"><h3 id="capacity-lanes" className={styles.title}>Lane capacity</h3>
            {lanes.length === 0 ? <p className={styles.muted}>No lanes reported.</p> : <ul className={styles.list}>{lanes.map((lane) => {
              const points = samples.map((sample) => {
                const value = sample.lanes.find((item) => item.lane === lane.lane);
                return { atMs: Date.parse(sample.at), running: value?.running ?? null, target: value?.target ?? null };
              });
              return <li key={lane.lane} className={styles.lane}>
                <div className={styles.line}><strong>{lane.lane}</strong><span>{percent(lane.fillPct)} of target · {format(lane.idleSlotMinutes)} idle slot-minutes · {format(lane.heldMinutes)} held min</span></div>
                <Chart points={points} samples={samples} held={lane.lane} label={`${lane.lane}: ran at ${percent(lane.fillPct)} of target, ${format(lane.idleSlotMinutes)} idle slot-minutes`} />
              </li>;
            })}</ul>}
          </section>
          <section className={styles.section} aria-labelledby="capacity-gaps"><h3 id="capacity-gaps" className={styles.title}>Launch gaps</h3>
            <p className={styles.muted}>Running counts stayed flat while work was queued; observation breaks over 5 minutes end a gap.</p>
            {gaps.length ? <ul className={styles.gaps}>{gaps.map((gap) => <li key={`${gap.fromMs}-${gap.toMs}`}><time dateTime={new Date(gap.fromMs).toISOString()}>{new Date(gap.fromMs).toLocaleString()}</time> – <time dateTime={new Date(gap.toMs).toISOString()}>{new Date(gap.toMs).toLocaleString()}</time> · {format(gap.minutes)} min</li>)}</ul> : <p className={styles.muted}>No launch gaps observed.</p>}
          </section>
          <section className={styles.section} aria-labelledby="capacity-workers"><h3 id="capacity-workers" className={styles.title}>Workers / leaders</h3>
            <p className={styles.muted}>Solid: workers · dashed: leaders · muted band: paused</p>
            {workerPoints.some((point) => point.running !== null || point.target !== null) ? <Chart points={workerPoints} samples={samples} label="Workers and leaders over time" /> : <p className={styles.muted}>No worker or leader counts reported.</p>}
          </section>
        </> : null}
      </>}
  </div>;
}
