/**
 * routes/verse/fleet-capacity/FleetCapacityPane.tsx — the Capacity board: how full the lanes ran against their slot
 * targets in the chosen window. A headline and fleet totals, one card per lane (most stalled first), a strip of when
 * the sampler was watching with the launch gaps marked on it, and the worker and leader counts. History comes from
 * GET /api/verse/runs-history; the usage window (GET /api/app/pools), hold reason, models and lane-truth lines come
 * from their own reads.
 */
import { laneModelsQuery } from './lane-models-query.js';
import { laneModelLine, mismatchText, laneModelsHeadline } from './lane-models-model.js';
import { useMemo, useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { NoFleetNotice } from '../fleet/NoFleetNotice.js';
import { isNoFleet } from '../fleet/no-fleet.js';
import { fleetUsageRunsQuery } from '../fleet-usage/fleet-usage-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { boardHeadline, fleetTotals, place, rankLanes, span, totalFacts, watchedMinutes, watchedSegments } from './capacity-board-model.js';
import { headline, laneSeries, launchGaps, stallHeadline } from './capacity-model.js';
import { runsHistoryQuery, type CapacityHours } from './capacity-queries.js';
import styles from './fleet-capacity.module.css';
import { laneHeldText } from './lane-held-text.js';
import { truthHeadline, verdictText, verdictTone } from './lane-truth-model.js';
import { ObserveSlice } from '../fleet-observe/ObserveFacts.js';
import { laneTruthQuery } from './lane-truth-queries.js';
import { CapacityChart, clock, Facts, LaneCapacityCard } from './LaneCapacityCard.js';
import { LaneUsage, LaneUsageKey, useLanePools } from './LaneUsage.js';

export function FleetCapacityPane({ visible, host }: Pick<PaneProps, 'visible'> & Partial<Pick<PaneProps, 'host'>>) {
  const [hours, setHours] = useState<CapacityHours>(24);
  const query = useMemo(() => runsHistoryQuery(hours), [hours]);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(query, { enabled: active, freshMs: 0 });
  const snapshot = useQuery(fleetUsageRunsQuery, { enabled: active });
  const models = useQuery(laneModelsQuery, { enabled: active });
  const refetchModels = useRefetch(laneModelsQuery);
  const refreshModels = useRefresh(laneModelsQuery);
  const truth = useQuery(laneTruthQuery, { enabled: active });
  const pools = useLanePools(active, visible);
  const refetchSnapshot = useRefetch(fleetUsageRunsQuery);
  const refreshSnapshot = useRefresh(fleetUsageRunsQuery);
  const refetchTruth = useRefetch(laneTruthQuery);
  const refreshTruth = useRefresh(laneTruthQuery);
  const refetch = useRefetch(query);
  const refresh = useRefresh(query);
  usePollWhileVisible(() => { refetch(); refetchSnapshot(); refetchTruth(); refetchModels(); }, 60_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const runs = snapshot.data && typeof snapshot.data === 'object' && !Array.isArray(snapshot.data)
    ? snapshot.data as Record<string, unknown> : {};
  const liveLanes = Array.isArray(runs.lanes) ? runs.lanes : [];
  const personal = runs.codexPersonal && typeof runs.codexPersonal === 'object' && !Array.isArray(runs.codexPersonal)
    ? runs.codexPersonal as Record<string, unknown> : {};
  const resetsAt = typeof personal.resetsAt === 'string' ? personal.resetsAt : null;
  const now = Date.now();
  const samples = data ? [...data.samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) : [];
  const noFleet = !!data && samples.length === 0 && isNoFleet(data.sourceState);
  const series = data ? laneSeries(data, now) : [];
  const lanes = rankLanes(series);
  const totals = fleetTotals(series);
  const stall = stallHeadline(series, now);
  const gaps = data ? launchGaps(data) : [];
  const truthLanes = truth.data?.source === 'ok' ? truth.data.lanes : [];
  const truthHeadlineText = truthHeadline(truthLanes);
  const modelsHeadline = laneModelsHeadline(models.data);
  const workerPoints = samples.map((sample) => ({ atMs: Date.parse(sample.at), running: sample.workers, target: sample.leaders }));
  const fromMs = data ? Date.parse(data.from) : 0;
  const toMs = data ? Date.parse(data.to) : 0;
  const watched = watchedSegments(samples.map((sample) => Date.parse(sample.at)));
  const watchedFor = watchedMinutes(watched);

  return <div className={styles.pane} aria-label="Capacity">
    <ObserveSlice visible={visible} part="capacity" />
    <header className={styles.header}>
      <div className={styles.heading}>
        {samples.length > 0 ? <p className={styles.big}>{boardHeadline(totals, series.length)}</p> : null}
        <p className={styles.headline}>{data && !noFleet ? headline(data, now) : 'Fleet capacity history'}</p>
      </div>
      <div className={styles.controls} role="group" aria-label="History window">
        {([6, 24, 72] as const).map((value) => <button type="button" className={styles.button} aria-pressed={hours === value} key={value} onClick={() => setHours(value)}>{value} h</button>)}
      </div>
      <button type="button" className={styles.button} onClick={() => { refresh(); refreshSnapshot(); refreshTruth(); refreshModels(); pools.refresh(); }}>Refresh</button>
    </header>
    {modelsHeadline ? <p className={styles.muted}>{modelsHeadline}</p> : null}
    {truthHeadlineText ? <p className={styles.truth} data-testid="lane-truth-headline">{truthHeadlineText}</p> : null}
    {data === null ? <p className={styles.muted}>Capacity history has not landed in this build yet.</p>
      : !data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Capacity history is unavailable.' : 'Reading capacity history…'}</p>
      : <>
        {/* A failed refresh keeps the last reading on screen; it must not read as current. */}
        {read.status === 'error' ? <p className={styles.stall} role="status">Capacity history could not refresh. Showing the last reading.</p> : null}
        {noFleet ? <NoFleetNotice /> : null}
        {samples.length > 0 ? <>
          <Facts facts={totalFacts(totals, watchedFor, hours)} label="Fleet totals" />
          {stall ? <p className={styles.stall} role="status">{stall}</p> : null}
          <section className={styles.section} aria-labelledby="capacity-lanes"><h3 id="capacity-lanes" className={styles.title}>Lane capacity</h3>
            <p className={styles.muted}>Solid: running · dashed: target · shaded: held · muted band: paused. Breaks indicate missing observations.</p>
            <LaneUsageKey lanes={lanes.map((lane) => lane.lane)} pools={pools} />
            {lanes.length === 0 ? <p className={styles.muted}>No lanes reported.</p> : <ul className={styles.list}>{lanes.map((lane) => {
              const live = liveLanes.find((item: unknown) => item && typeof item === 'object' && 'lane' in item && item.lane === lane.lane) as Record<string, unknown> | undefined;
              const heldText = live ? laneHeldText({ lane: lane.lane, held: live.held === true, heldReason: typeof live.heldReason === 'string' ? live.heldReason : null }, { resetsAt }) : null;
              const modelLine = laneModelLine(lane.lane, models.data, now);
              const mismatch = mismatchText(lane.lane, models.data);
              const truthRow = truthLanes.find((row) => row.lane === lane.lane);
              const truthLine = truthRow ? verdictText(truthRow) : null;
              return <LaneCapacityCard key={lane.lane} lane={lane} samples={samples} onOpen={() => host?.openPane('fleet-lanes')}>
                <LaneUsage lane={lane} pools={pools} hours={hours} onOpen={host ? () => host.openPane('fleet-pools') : undefined} />
                {modelLine ? <p className={styles.muted} data-testid="lane-models">{modelLine}</p> : null}
                {mismatch ? <p className={styles.truth} data-tone="warning">{mismatch}</p> : null}
                {heldText ? <p className={styles.muted} data-testid="lane-held">{heldText}</p> : null}
                {truthLine ? <p className={styles.truth} data-tone={verdictTone(truthRow!.verdict) ?? undefined} data-testid="lane-truth">{truthLine}</p> : null}
              </LaneCapacityCard>;
            })}</ul>}
          </section>
          <section className={styles.section} aria-labelledby="capacity-gaps"><h3 id="capacity-gaps" className={styles.title}>Launch gaps</h3>
            <p className={styles.muted}>Running counts stayed flat while work was queued; observation breaks over 5 minutes end a gap.</p>
            {/* The whole window as one strip: the parts with samples, and the gaps on top. The rest was not watched, so it claims nothing. */}
            <div className={styles.strip} role="img" aria-label={`Watched ${span(watchedFor)} of the last ${hours} h, ${gaps.length} launch ${gaps.length === 1 ? 'gap' : 'gaps'} marked`}>
              {watched.map((segment) => { const at = place(segment, fromMs, toMs); return <span key={segment.fromMs} className={styles.watched} style={{ left: `${at.left}%`, width: `${at.width}%` }} />; })}
              {gaps.map((gap) => { const at = place(gap, fromMs, toMs); return <span key={gap.fromMs} className={styles.gap} style={{ left: `${at.left}%`, width: `${at.width}%` }} />; })}
            </div>
            <p className={styles.axis}><time dateTime={data.from}>{clock(fromMs)}</time><span>filled: watched · amber: launch gap · hatched: not watched</span><time dateTime={data.to}>{clock(toMs)}</time></p>
            <p className={styles.muted}>Observed: {new Date(samples[0].at).toLocaleString()} – {new Date(samples[samples.length - 1].at).toLocaleString()}</p>
            {gaps.length ? <ul className={styles.gaps}>{gaps.map((gap) => <li key={`${gap.fromMs}-${gap.toMs}`}><time dateTime={new Date(gap.fromMs).toISOString()}>{new Date(gap.fromMs).toLocaleString()}</time> – <time dateTime={new Date(gap.toMs).toISOString()}>{new Date(gap.toMs).toLocaleString()}</time> · {span(gap.minutes)}</li>)}</ul> : <p className={styles.muted}>No launch gaps observed.</p>}
          </section>
          <section className={styles.section} aria-labelledby="capacity-workers"><h3 id="capacity-workers" className={styles.title}>Workers / leaders</h3>
            <p className={styles.muted}>Solid: workers · dashed: leaders · muted band: paused</p>
            {workerPoints.some((point) => point.running !== null || point.target !== null) ? <CapacityChart points={workerPoints} samples={samples} unit="processes" label="Workers and leaders over time" /> : <p className={styles.muted}>No worker or leader counts reported.</p>}
          </section>
        </> : null}
      </>}
  </div>;
}
