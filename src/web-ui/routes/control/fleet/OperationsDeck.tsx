import { useEffect, type ReactNode } from 'react';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../../../../core/fleet/lane-health.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { runQuery } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { fleetLanesQuery, fleetStatusQuery, queueStatsQuery, type QueryDef } from '../../../data/queries.js';
import { fleetLiveQuery } from '../../verse/command/surface-data.js';
import { tickStaleness } from '../../verse/fleet/tick-staleness.js';
import styles from './OperationsDeck.module.css';

const computeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-operations-compute',
  fetch: signal => apiGet('/api/verse/fleet/control/compute', signal),
};
const queueQuery = queueStatsQuery();
const COMPUTE = '/api/verse/fleet/control/compute';
const STATUS = `${COMPUTE} · queue/status.json`;
const LIVE = '/api/verse/fleet/live';
const show = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';

/** The same read-only operations deck on the console and Verse Fleet surfaces. */
export function OperationsDeck({ sourceBadges }: { sourceBadges?: ReactNode } = {}) {
  const compute = useQuery(computeQuery);
  const daemon = useQuery(fleetStatusQuery);
  const queue = useQuery(queueQuery);
  const lanes = useQuery(fleetLanesQuery);
  const live = useQuery(fleetLiveQuery);
  const refreshCompute = useRefetch(computeQuery);
  const refreshDaemon = useRefetch(fleetStatusQuery);
  const refreshQueue = useRefetch(queueQuery);
  const refreshLanes = useRefetch(fleetLanesQuery);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      refreshCompute(); refreshQueue(); refreshLanes(); refreshDaemon();
      void runQuery(fleetLiveQuery.key, () => fleetLiveQuery.fetch());
    };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [refreshCompute, refreshQueue, refreshLanes, refreshDaemon]);

  // Failed refreshes must not present cached admission as a current permission.
  const machine = compute.status === 'error' ? null : compute.data;
  const fleet = live.status === 'error' ? null : live.data?.value;
  const admission = machine?.operations?.admission;
  const tick = tickStaleness(machine?.dispatcherAt ?? null, Date.now());
  const admissionTick = tickStaleness(admission?.observedAt ?? null, Date.now());
  const freshAdmission = admissionTick.level === 'fresh';
  const health = fleet && fleet.state !== 'dark' ? computeLaneHealth(fleet) : null;
  const laneRows = lanes.status === 'error' ? [] : lanes.data?.lanes ?? [];
  const laneNames = [...new Set([...laneRows.map(l => l.lane), ...(health?.lanes.map(l => l.lane) ?? [])])];
  const mergeQueue = queue.status === 'error' ? null : queue.data?.stations.find(s => s.station === 'merge-queue');
  const daemonTick = tickStaleness(daemon.status === 'error' ? null : daemon.data?.daemon?.lastTickAt ?? null, Date.now());
  const items: Array<{ text: string; source: string }> = [];
  if (daemonTick.level === 'stale' || daemonTick.level === 'late') items.push({ text: `Daemon ${daemonTick.text}`, source: '/api/fleet · daemon.lastTickAt' });
  if (tick.level === 'stale' || tick.level === 'late') items.push({ text: `Dispatcher ${tick.text}`, source: `${STATUS} · last_tick` });
  if (admission?.admit === false) items.push({ text: `Admission held: ${admission.gateReason ?? 'reason unknown'}${freshAdmission ? '' : ' (last observation; freshness unknown or late)'}`, source: `${STATUS} · admission.admit / gate_reason / ts` });
  for (const warning of admission?.warnings ?? []) items.push({ text: warning, source: `${STATUS} · admission.warnings` });
  for (const run of fleet?.runs ?? []) {
    if (run.outcome === 'owner-lane' && run.prNumber !== null) items.push({ text: `${run.repo} #${run.prNumber} held for owner lane; reason unknown`, source: `${LIVE} · runs[${run.id}].outcome / prNumber` });
  }
  for (const hold of fleet?.blockedHolds ?? []) items.push({ text: `${hold.repo}: ${hold.reason}`, source: `${LIVE} · blockedHolds` });

  return <section className={styles.deck} aria-label="Fleet operations">
    <h2>Operations</h2>
    {sourceBadges}
    <p className={styles.note}>Refreshes every 15s while visible. Hover a reading or open evidence for its source.</p>
    <div role="status" aria-live="polite" aria-atomic="true" className={styles.note}>
      {[{ status: compute.status, label: 'Compute' }, { status: queue.status, label: 'Queue' }, { status: lanes.status, label: 'Lanes' }, { status: live.status, label: 'Health' }, { status: daemon.status, label: 'Daemon' }].map(({ status, label }) =>
        <span key={label}>{label}: {status === 'error' ? 'unavailable' : status}{' · '}</span>)}
    </div>
    <section className={styles.needs} aria-label="Needs you">
      <h3>Needs you</h3>
      {items.length ? <ol>{items.slice(0, 5).map((item, index) => <li key={`${item.source}-${index}`}>
        {item.text}<details><summary>Evidence</summary><p>{item.source}</p></details>
      </li>)}</ol> : <p>{!machine || !fleet || daemonTick.level === 'unknown' || !admission || admission.warnings === null || fleet.blockedHolds == null ? 'Needs-you evidence unknown or incomplete.' : 'No operator actions reported by these sources.'}</p>}
      {items.length > 5 ? <p>More items are recorded in the source projections.</p> : null}
    </section>
    <section aria-label="Why isn't it launching">
      <h3>Why isn't it launching?</h3>
      <p>{machine?.launchVitals?.reason ?? 'Reason unknown.'} Next launch window: {machine?.launchVitals?.nextWindowSeconds == null ? 'unknown' : `${machine.launchVitals.nextWindowSeconds} seconds`}. Queued: {show(machine?.launchVitals?.queued)}.</p>
      {machine?.launchVitals?.lanes.map(lane => <p key={lane.lane}>{lane.lane}: {show(lane.running)} running of {show(lane.target)} target; {show(lane.queued)} queued</p>)}
    </section>
    <dl className={styles.metrics}>
      <div title={`${STATUS} · publishes_24h`}><dt>Publishes · 24h</dt><dd>{show(machine?.operations?.publishes24h)}</dd></div>
      <div title="/api/queue/stats?window=3600 · stations[merge-queue].windows.currentQueueLength"><dt>Merge-queue depth</dt><dd>{show(mergeQueue?.currentQueueLength)}</dd></div>
      <div title={`${STATUS} · admission.admit / ts`}><dt>Admission</dt><dd>{!freshAdmission || admission?.admit == null ? 'unknown' : admission.admit ? 'admit' : 'held'}</dd></div>
      <div title={`${STATUS} · admission.gate_reason`}><dt>Gate reason</dt><dd>{admission?.gateReason ?? 'unknown'}</dd></div>
      <div title={`${STATUS} · last_tick`}><dt>Dispatcher</dt><dd>{tick.text}</dd></div>
    </dl>
    <details className={styles.note}><summary>Observation times and evidence</summary>
      <p>{STATUS} · generatedAt: {machine?.generatedAt ?? 'unknown'} · admission.ts: {admission?.observedAt ?? 'unknown'}</p>
      <p>/api/queue/stats?window=3600 · generatedAt: {queue.data ? new Date(queue.data.generatedAt).toISOString() : 'unknown'}. Depth is the recorded merge-queue station, not a live GitHub query.</p>
      <p>{LIVE} · generatedAt: {fleet?.generatedAt ?? 'unknown'} · lane health uses computeLaneHealth, the same projection as phm lanes health.</p>
    </details>
    <div className={styles.tableWrap}><table>
      <caption>Lane queue and health · last 12h · unknown means unmeasured</caption>
      <thead><tr><th scope="col">Lane</th><th scope="col">Queue</th><th scope="col">Calls · errors · p50 · deployed commit</th><th scope="col">Stuck phases</th></tr></thead>
      <tbody>{laneNames.length ? laneNames.map(name => {
        const lane = laneRows.find(l => l.lane === name);
        const measured = health?.lanes.find(h => h.lane === name);
        return <tr key={name}><th scope="row">{name}</th>
          <td title={`/api/fleet/lanes · lanes[${name}].queueDepth · ready.tsv`}>{show(lane?.queueDepth)}</td>
          <td title={`${LIVE} · runs / commit → computeLaneHealth`}>{measured ? laneHealthLine(measured) : 'unknown'}</td>
          <td title={`${LIVE} · runs.phaseStartedAt / phase → PHASE_TIMEOUT_MS`}>{measured ? stuckBadge(measured) ?? 'None observed' : 'unknown'}</td></tr>;
      }) : <tr><td colSpan={4}>Lane evidence unknown or empty.</td></tr>}</tbody>
    </table></div>
  </section>;
}
