/**
 * routes/verse/ops/OpsFleet.tsx : the fleet and router view: each lane's
 * capacity, what the router held and why, the seat choices behind recent
 * dispatches, and the calibration harness's A/B results (which arm won and
 * by how much). Read-only; control lives on the Fleet surface.
 */
import { useRefetch, useQuery } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { opsFleetQuery } from './ops-queries.js';
import { OpsLaneConsole } from './OpsLaneConsole.js';
import type { OpsExperimentV1, OpsRouteDecision } from '../../../../core/verse/ops-types.js';
import styles from './ops.module.css';

function liftText(lift: OpsExperimentV1['lift']): string | null {
  if (!lift) return null;
  const sign = lift.mean > 0 ? '+' : '';
  return `${sign}${lift.mean.toFixed(1)} pts (${lift.ciLow.toFixed(1)} to ${lift.ciHigh.toFixed(1)})`;
}

function ExperimentRow({ exp }: { exp: OpsExperimentV1 }) {
  const lift = liftText(exp.lift);
  return (
    <div className={styles.row} data-verdict={exp.verdict ?? undefined}>
      <p className={styles.rowTitle}>
        <strong>{exp.id}</strong>
        <span className={styles.chip}>{exp.status}</span>
        {exp.verdict ? <span className={styles.chip} data-tone={exp.verdict === 'adopt' ? 'good' : exp.verdict === 'reject' ? 'bad' : undefined}>{exp.verdict}</span> : null}
      </p>
      <p className={styles.rowMeta}>
        arms {exp.arms.base} vs {exp.arms.candidate}
        {' · '}{exp.pairs} pairs: {exp.wins}W / {exp.losses}L / {exp.ties}T
        {lift ? ` · lift ${lift}` : ' · lift not measured yet'}
      </p>
      {exp.reasons.length > 0 ? <p className={styles.rowMeta}>{exp.reasons[0]}</p> : null}
    </div>
  );
}

function DecisionRow({ decision }: { decision: OpsRouteDecision }) {
  return (
    <div className={styles.row}>
      <p className={styles.rowTitle}>
        <strong>{decision.title || decision.itemId}</strong>
        <span className={styles.chip}>{decision.dispatched ? 'dispatched' : 'held'}</span>
      </p>
      <p className={styles.rowMeta}>
        {decision.repo}
        {decision.seatId ? ` · seat ${decision.seatId}` : ''}
        {decision.lane ? ` · lane ${decision.lane}` : ''}
        {decision.skipReason ? ` · ${decision.skipReason}` : ''}
      </p>
      {decision.summary || decision.why ? <p className={styles.rowMeta}>{decision.summary ?? decision.why}</p> : null}
    </div>
  );
}

export function OpsFleet() {
  const read = useQuery(opsFleetQuery, { freshMs: 8_000 });
  const refetch = useRefetch(opsFleetQuery);
  usePollWhileVisible(refetch, 15_000);
  const fleet = read.data;

  // The per-lane console (GET /api/fleet/lanes) mounts first, above the router's own read.
  const fleetPanel = (
    <section className={styles.panel} aria-labelledby="ops-fleet-title">
      <div className={styles.header}>
        <div>
          <h2 id="ops-fleet-title">Fleet and router</h2>
          <p>Lanes as the router sees them, what it held and why, and the calibration A/B results.</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>
      {read.status === 'error' ? <p role="status">The fleet projection is unavailable. Refresh to reconnect.</p>
        : !fleet ? <p role="status">Reading the fleet…</p>
        : <>
            {fleet.holdProduction ? <p role="status" className={styles.note}>Production is held: {fleet.holdProduction}</p> : null}
            {fleet.tickAt ? <p className={styles.note}>Router state from {fleet.tickAt}.</p>
              : <p className={styles.note}>The router has not ticked yet, so lane state is unknown.</p>}

            <h3 className={styles.groupTitle}>Lanes</h3>
            {fleet.lanes === null || fleet.lanes.length === 0
              ? <p className={styles.empty}>No lane state to show.</p>
              : <div className={styles.laneGrid}>
                  {fleet.lanes.map((lane) => (
                    <div key={lane.lane} className={styles.lane} data-off={lane.slots === 0 || undefined}>
                      <p className={styles.laneName}>{lane.lane}</p>
                      <p className={styles.laneStat}>{lane.busy} busy · {lane.slots} slot{lane.slots === 1 ? '' : 's'}</p>
                      {lane.capReason ? <p className={styles.laneCap}>{lane.capReason}</p> : null}
                    </div>
                  ))}
                </div>}

            <h3 className={styles.groupTitle}>Held by the router</h3>
            {fleet.held.length === 0
              ? <p className={styles.empty}>Nothing is parked right now.</p>
              : <div className={styles.list}>{fleet.held.map((h) => (
                  <div key={h.itemId} className={styles.row}>
                    <p className={styles.rowTitle}><strong>{h.title || h.itemId}</strong><span className={styles.chip}>{h.holdKind}</span></p>
                    <p className={styles.rowMeta}>{h.repo} · {h.reason}{h.nextEligibleAt ? ` · eligible ${h.nextEligibleAt}` : ''}</p>
                  </div>
                ))}</div>}

            <h3 className={styles.groupTitle}>Router decisions</h3>
            {fleet.decisions.length === 0
              ? <p className={styles.empty}>No dispatches in the last day.</p>
              : <div className={styles.list}>{fleet.decisions.map((d) => <DecisionRow key={`${d.at}:${d.itemId}`} decision={d} />)}</div>}

            <h3 className={styles.groupTitle}>A/B results</h3>
            {fleet.experiments.length === 0
              ? <p className={styles.empty}>No calibration experiments yet.</p>
              : <div className={styles.list}>{fleet.experiments.map((e) => <ExperimentRow key={e.id} exp={e} />)}</div>}
          </>}
    </section>
  );
  return (<><OpsLaneConsole />{fleetPanel}</>);
}
