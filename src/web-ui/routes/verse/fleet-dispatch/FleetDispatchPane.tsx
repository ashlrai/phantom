import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, SkeletonLine, StatusBadge } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { getQuerySnapshot, subscribeQuery, type QueryEntry } from '../../../data/cache.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { NoFleetNotice } from '../fleet/NoFleetNotice.js';
import { requestLaneFocus } from '../fleet-lanes/lane-focus-request.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { isNoFleet } from '../fleet/no-fleet.js';
import { fleetUsageRunsQuery } from '../fleet-usage/fleet-usage-queries.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { dispatchTellKinds, dispatchTellPrefill } from './dispatch-tell.js';
import { readDispatch } from './fleet-dispatch-model.js';
import { fleetDispatchQuery } from './fleet-dispatch-queries.js';
import { fillerTellPrefill, mixHeadline, runningMix } from './running-mix-model.js';
import { plannerLine } from './planner-plan-model.js';
import { plannerPlanQuery, type PlannerPlanView } from './planner-plan-queries.js';
import styles from './fleet-dispatch.module.css';

const PLANNER_IDLE: QueryEntry<PlannerPlanView | null> = { data: undefined, error: undefined, status: 'idle', updatedAt: null };

export function FleetDispatchPane({ visible, host, roots }: PaneProps) {
  const read = useQuery(fleetDispatchQuery, { enabled: visible, freshMs: 0 });
  const runs = useQuery(fleetUsageRunsQuery, { enabled: visible });
  const refetch = useRefetch(fleetDispatchQuery);
  const refetchPlan = useRefetch(plannerPlanQuery);
  // The planner read is slower than the lane poll: the lane poll stays 10 s,
  // this subscribes without a mount fetch and re-reads every 30 s plus on
  // show. A pane mounted already visible (the usual case) still fetches at
  // once; a pane mounted hidden costs nothing until it is shown.
  const mountedVisible = useRef(visible);
  useEffect(() => { if (mountedVisible.current) refetchPlan(); }, [refetchPlan]);
  usePollWhileVisible(refetchPlan, 30_000, { enabled: visible });
  const plan = useSyncExternalStore(
    useCallback(listener => (visible ? subscribeQuery(plannerPlanQuery.key, listener) : () => {}), [visible]),
    () => (visible ? getQuerySnapshot<PlannerPlanView | null>(plannerPlanQuery.key) : PLANNER_IDLE),
    () => PLANNER_IDLE,
  );
  const [, setTick] = useState(0);
  const poll = useCallback(() => { setTick(tick => tick + 1); refetch(); }, [refetch]);
  usePollWhileVisible(poll, 10_000, { enabled: visible });
  const nowMs = Date.now();
  const data = readDispatch(read.data, nowMs);
  const planner = plannerLine(plan.data, nowMs);
  const mix = runningMix(isFleetRuns(runs.data) ? runs.data : null);
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  if (!data) return <p className={styles.message} role="status">Live runs are unavailable.</p>;
  return <section className={styles.root} aria-label="Dispatch">
    {planner && <p className={styles.planner} data-tone={planner.tone} role={planner.tone === 'bad' ? 'alert' : 'status'}>{planner.text}</p>}
    <p className={styles.header}>{data.supply.freeSlots} free slots · {data.supply.queued} queued · {data.supply.text}</p>
    {isNoFleet(data.sourceState) ? <NoFleetNotice /> : data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Dispatch data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    {data.incidents.map(item => <div key={item.id} className={styles.notice} role="alert"><strong>{item.title}</strong> {item.detail} {item.fix}</div>)}
    <ul className={styles.list} aria-label="Lane verdicts">{data.verdicts.map(item => <li key={item.lane} className={styles.row}>
      <div className={styles.verdict}><strong><button type="button" className={styles.laneButton} aria-label={`Open ${item.lane} in Lanes`} onClick={() => { requestLaneFocus(item.lane); host.openPane('fleet-lanes'); }}>{item.lane}</button></strong><StatusBadge status={item.kind} tone={item.tone === 'ok' ? 'success' : item.tone === 'warn' ? 'warning' : item.tone} /><span>{item.headline}</span></div>
      {item.action && <p className={styles.action}>{item.action}{item.action.startsWith('Run ') && <> <Button size="sm" onClick={() => host.openTerminal({ ...(roots[0] ? { root: roots[0] } : {}), paste: item.action!.slice(4) })}>Paste in Terminal</Button></>}</p>}
      {dispatchTellKinds().has(item.kind) && <Button size="sm" variant="ghost" aria-label={`Tell the leaders about ${item.lane}`} onClick={() => openInterjectDialog({ prefill: dispatchTellPrefill(item) })}>Tell the leaders</Button>}
    </li>)}</ul>
    <section aria-labelledby="running-mix-heading">
      <h2 id="running-mix-heading" className={styles.mixHeading}>Running mix</h2>
      <p className={styles.header}>{mixHeadline(mix)}</p>
      {mix.length > 0 && <ul className={styles.list} aria-label="Running mix by lane">{mix.map(row => {
        const prefill = fillerTellPrefill(row);
        return <li key={row.lane} className={styles.row}>
          <span><strong>{row.lane}</strong> · {row.running} running: {row.phx} Phantom, {row.fixup} fix-ups, {row.filler} filler ({row.fillerPct === null ? '—' : `${Math.round(row.fillerPct)}%`}), {row.other} other</span>
          {(row.claimedPhx > 0 || row.claimedOther > 0) && <span>{row.claimedPhx} Phantom claimed, {row.claimedOther} other claimed</span>}
          {prefill !== null && <Button size="sm" variant="ghost" aria-label={`Tell the leaders about filler on ${row.lane}`} onClick={() => openInterjectDialog({ prefill })}>Tell the leaders</Button>}
        </li>;
      })}</ul>}
    </section>
  </section>;
}
