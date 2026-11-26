import { useEffect, useMemo, useRef, useState } from 'react';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import type { ComputeNode, FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { ComputeHost } from '../../../../core/fleet/compute-hosts.js';
import { apiGet } from '../../../data/client.js';
import { fleetLanesQuery, type QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { onFleetComputeRefresh } from '../verse-list-channel.js';
import { invalidateObserved } from '../../../data/cache.js';
import { jobDetailQuery } from '../fleet-job-log/worker-log-queries.js';
import { JobActivity } from '../fleet-job-log/JobActivity.js';
import { SessionLive } from './SessionLive.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { openDockPane } from '../dock/dock-store.js';
import { agentBusPageQuery } from '../fleet-bus/agent-bus-queries.js';
import { fleetOrgMapQuery } from '../fleet/org-map-query.js';
import { advanceCores, fresh, isFleetCompute, isFleetSessionMap, loadRatio, type CoreHistory, type MapSession } from './compute-model.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { ComputeScene3D, OrgMessages } from './ComputeScene3D.js';
import { recordedAt, shown } from './company-model.js';
import styles from './compute.module.css';

export const computeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-compute', fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/compute', signal);
    if (!isFleetCompute(value)) throw new Error('Unsupported compute observation');
    return value;
  },
};
export const sessionsMapQuery: QueryDef<FleetSessionMap> = {
  key: 'fleet-sessions-map', fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/sessions', signal);
    if (!isFleetSessionMap(value)) throw new Error('Unsupported session observation');
    return value;
  },
};
const coordinationQuery = agentBusPageQuery(0, 100);
const gib = (v: number | null | undefined) => v == null ? 'unknown' : `${(v / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Load-versus-ceiling bands, shared by the machine card's edge and its meter.
 * A bare <meter> draws green at every value, so a host at 221% of its ceiling
 * showed a red card with a full green bar inside it.
 */
const HEAT_WARM = 0.7;
/** Just under a full bar: the meter turns red only above `high`, and the value is capped at 1. */
const HEAT_HOT = 0.999;
export function heatBand(ratio: number): 'hot' | 'warm' | 'cool' {
  return ratio >= 1 ? 'hot' : ratio >= HEAT_WARM ? 'warm' : 'cool';
}

/** The lane card's edge colour. A hold outranks quota; a lane with neither reading stays unknown, never green. */
export function laneQuotaState(held: boolean | null | undefined, quotaOk: boolean | null | undefined): 'held' | 'blocked' | 'ok' | 'unknown' {
  if (held) return 'held';
  if (quotaOk === false) return 'blocked';
  return quotaOk === true ? 'ok' : 'unknown';
}

function CoreSparks({ history, current }: { history?: CoreHistory; current: boolean }) {
  if (!history || !current) return <p>Per-core utilization unknown</p>;
  return <details><summary>Per-core utilization · last {history.samples.length} observations</summary>
    <div className={styles.cores}>{history.previous.cores.map((_, core) => {
      const value = history.samples.at(-1)?.[core];
      let pen = false;
      const d = history.samples.map((s, i) => {
        const v = s[core];
        if (v == null) { pen = false; return ''; }
        const segment = `${pen ? 'L' : 'M'}${i * 3},${30 - v * 0.3}`; pen = true; return segment;
      }).join(' ');
      return <div key={core}><small>CPU {core + 1}: {value == null ? 'unknown · awaiting delta' : `${value.toFixed(0)}%`}</small>
        <svg viewBox="0 0 96 32" role="img" aria-label={`CPU ${core + 1} history`}><path d={d} fill="none" stroke="currentColor" /></svg></div>;
    })}</div></details>;
}

/** Workers grouped per physical Mac. Sums come from advertised slots of live workers only; unknown stays unknown. */
function PoolHosts({ data, now }: { data: FleetCompute; now: number }) {
  const hosts: ComputeHost[] = data.hosts ?? [], totals = data.pool;
  if (!totals) return <p>Node-pool host rollup unavailable from this server.</p>;
  return <section className={styles.hosts} aria-label="Node pool hosts">
    <h3>Node-pool hosts</h3>
    <p>{totals.hosts} hosts · {totals.liveWorkers} live workers · live slots {shown(totals.liveSlots)} / RAM-budget slots {totals.ramSlots}
      {totals.oversubscribedHosts ? ` · ${totals.oversubscribedHosts} oversubscribed` : ''}
      {totals.unplacedNodes ? ` · ${totals.unplacedNodes} nodes without host telemetry (host unknown)` : ''}</p>
    <div className={styles.hostRows}>{hosts.map(h => <article key={h.id} className={styles.host} data-over={h.oversubscribed === null ? 'unknown' : String(h.oversubscribed)}>
      <h4>{h.nodeIds.join(' + ')}</h4>
      <small>{h.inferred ? 'Workers grouped by matching RAM, CPUs and boot time' : 'Single worker'} · {gib(h.ramTotal)} · {h.cores} CPUs · telemetry {recordedAt(h.observedAt, now)}</small>
      <span>{h.liveWorkers}/{h.nodeIds.length} workers live · live slots {shown(h.liveSlots)} · RAM-budget slots {h.ramSlots} · claims {h.claims}</span>
      <strong>{h.oversubscribed === null ? 'Oversubscription unknown' : h.oversubscribed ? `OVERSUBSCRIBED · ${h.liveSlots} advertised vs ${h.ramSlots} RAM-budget` : 'Within RAM budget'}</strong>
      <span>Caps: {h.caps.length ? h.caps.join(', ') : 'none reported'}{h.heldWorkers ? ` · ${h.heldWorkers} held (0 slots; reason not recorded)` : ''}</span>
    </article>)}</div>
  </section>;
}

function Token({ session, selected, choose }: { session: MapSession; selected: boolean; choose: () => void }) {
  return <button type="button" className={styles.token} data-state={session.mapState} aria-pressed={selected} onClick={choose}>
    <strong>{session.job}</strong><ProviderBadge of={session.model} lane={session.lane} /><span>{session.lane ?? 'lane unknown'} · {session.model ?? 'model unknown'}</span>
    <span>{session.status} · {session.elapsedSeconds === null ? 'age unknown' : `${Math.floor(session.elapsedSeconds / 60)}m elapsed`}</span>
    <small>{session.activity ? `Last log excerpt (time unknown): ${session.activity}` : 'Activity unknown'}</small>
  </button>;
}

/** The side panel a map node opens: the session's live window first, then its placement and coordination records. */
function AgentDetail({ session, node, enabled, openLog, close, known }: { session: MapSession; node?: ComputeNode; enabled: boolean; openLog: () => void; close: () => void;
  known: Pick<Parameters<typeof SessionLive>[0]['known'], 'repo' | 'startedAt' | 'tokens'> }) {
  const query = useMemo(() => jobDetailQuery(session.job), [session.job]);
  const localDetail = enabled && session.placement !== 'conflict' && (session.placement !== 'claim' || node?.local === true) && !['unknown', 'queued', 'parked'].includes(session.status);
  const detail = useQuery(query, { enabled: localDetail, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 5_000, { enabled: localDetail });
  const bus = useQuery(coordinationQuery, { enabled });
  const refreshBus = useRefetch(coordinationQuery);
  usePollWhileVisible(refreshBus, 5_000, { enabled });
  const messages = bus.data?.messages.filter(row => {
    const body = row.envelope.body as { jobId?: unknown } | null;
    return body?.jobId === session.job || row.envelope.from === session.job || row.envelope.to === session.job;
  }) ?? [];
  const data = localDetail ? detail.data : undefined;
  return <section className={styles.detail} aria-label="Agent detail" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <button type="button" className={styles.close} onClick={close}>Close</button>
    <h3>{session.job}</h3><p>{session.status}</p>
    <SessionLive job={session.job} local={localDetail} enabled={enabled} known={{ ...known, lane: session.lane, model: session.model }} />
    <p>Node: {node?.id ?? 'unassigned / placement unknown'} · Owner: {node?.jobs.find(j => j.job === session.job)?.owner ?? 'unknown'}</p>
    <p>Branch: {session.branch ?? data?.branch ?? 'unknown'} · Worktree: {session.worktree === 'recorded' ? 'recorded; current presence unknown' : 'unknown'}</p>
    <p>Placement evidence: {session.placement} · Elapsed: {session.elapsedSeconds === null ? 'unknown' : `${session.elapsedSeconds}s`} · Activity: {session.activity ?? 'unknown'}</p>
    <p>Outcome: {session.outcome ?? 'unknown'} · Merge state: {data?.publish?.autoMerge === true ? 'auto-merge enabled' : 'unknown'}</p>
    {(data?.publish?.prUrl ?? session.prUrl) ? <a href={data?.publish?.prUrl ?? session.prUrl!} target="_blank" rel="noreferrer">Open recorded PR</a> : <p>PR: unknown</p>}
    {detail.status === 'error' && <p role="alert">Job detail unavailable; retained details may be stale.</p>}
    <button type="button" disabled={!localDetail} onClick={openLog}>Open full job log</button><small> Full log, brief, notes and the worktree's changed files.</small>
    <h4>Claims & handoffs</h4><p>Matching records in the first 100 retained bus messages; this is a partial coordination window.</p>
    {bus.status === 'error' && <p role="alert">Coordination refresh failed; retained records may be stale.</p>}
    {messages.length ? <ul>{messages.map(row => {
      const kind = (row.envelope.body as { kind?: unknown } | null)?.kind;
      return <li key={row.envelope.id}>{row.envelope.from} → {row.envelope.to} · {typeof kind === 'string' ? kind.slice(0, 64) : 'message'} · {new Date(row.receivedAt).toISOString()}</li>;
    })}</ul> : <p>{bus.data ? 'No matching records in this window.' : 'Coordination unknown.'}</p>}
    {localDetail ? <JobActivity job={session.job} enabled={localDetail} pollMs={5_000} /> : <p>Activity detail unavailable for this placement.</p>}
  </section>;
}

/** Both maps use the same observations, selection and detail pane. No seeded nodes or synthetic activity. */
export function ComputeMap({ visible, host }: Pick<PaneProps, 'visible'> & Partial<Pick<PaneProps, 'host'>>) {
  const sectionVisible = useSectionVisible(), documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const compute = useQuery(computeQuery, { enabled, freshMs: 0 });
  const sessions = useQuery(sessionsMapQuery, { enabled, freshMs: 0 });
  const lanes = useQuery(fleetLanesQuery, { enabled, freshMs: 0 });
  const org = useQuery(fleetOrgMapQuery, { enabled, freshMs: 0 });
  const refreshOrg = useRefetch(fleetOrgMapQuery);
  const refreshCompute = useRefetch(computeQuery), refreshSessions = useRefetch(sessionsMapQuery), refreshLanes = useRefetch(fleetLanesQuery);
  const lastPulse = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    let lastDetails = 0;
    return onFleetComputeRefresh(() => {
      const now = Date.now();
      lastPulse.current = now;
      refreshCompute();
      refreshSessions();
      if (now - lastDetails < 15_000) return;
      lastDetails = now;
      refreshLanes();
      refreshOrg();
      invalidateObserved('verse-world');
    });
  }, [enabled, refreshCompute, refreshSessions, refreshLanes, refreshOrg]);
  usePollWhileVisible(() => {
    if (Date.now() - lastPulse.current < 20_000) return;
    refreshCompute(); refreshSessions(); refreshLanes(); refreshOrg();
  }, 30_000, { enabled });
  const [mode, setMode] = useState<'2D' | '3D'>('2D');
  const [group, setGroup] = useState(true), [heat, setHeat] = useState(true);
  const [yaw, setYaw] = useState(0), [tilt, setTilt] = useState(15), [zoom, setZoom] = useState(1);
  const [selection, select] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, CoreHistory>>({});
  const data = compute.data;
  const laneRows = Array.isArray(lanes.data?.lanes) ? lanes.data.lanes : [];
  useEffect(() => {
    if (!data) return;
    setHistory(old => Object.fromEntries(data.nodes.filter(n => n.stats).map(n => [n.id, advanceCores(old[n.id], n.stats!, Date.parse(data.generatedAt))])));
  }, [data]);
  const now = Date.now();
  // Scene geometry is rebuilt only when observations change, not on every slider move.
  const now3d = useMemo(() => Date.now(), [data, sessions.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodes = data?.nodes ?? [];
  const jobs = sessions.data?.mapSessions ?? [];
  const location = (job: MapSession) => job.nodeId;
  const selected = jobs.find(j => j.job === selection) ?? sessions.data?.mapRecent.find(j => j.job === selection);
  const maxCores = Math.max(1, ...nodes.map(n => n.stats?.cores.length ?? 0));
  function tokens(rows: MapSession[]) {
    const groups = group ? [...new Set(rows.map(s => s.lane ?? 'Lane unknown'))] : ['All lanes'];
    return groups.map(lane => {
      const members = group ? rows.filter(s => (s.lane ?? 'Lane unknown') === lane) : rows;
      return <section key={lane} className={styles.lane} aria-label={lane}><h4>{lane}</h4>{(['running', 'idle', 'held', 'queued', 'unknown'] as const).map(state => {
        const rows = members.filter(s => s.mapState === state);
        return rows.length ? <div key={state} role="group" aria-label={`${lane} ${state}`}><small>{state}</small>
          {rows.map(s => <Token key={s.job} session={s} selected={s.job === selection} choose={() => select(s.job)} />)}</div> : null;
      })}</section>;
    });
  }
  const row = selected && [...(sessions.data?.sessions ?? []), ...(sessions.data?.recent ?? [])].find(s => s.job === selected.job);
  return <section className={styles.root} aria-label="Fleet compute map" data-panel={selected ? 'open' : undefined}>
    <header><p>PHANTOM / LIVE FLEET</p><h2>The company at work</h2><p>Compute → lanes → agents. Every reading carries its source time.</p></header>
    <div className={styles.toolbar} role="group" aria-label="Map controls">
      {(['2D', '3D'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m}</button>)}
      <label><input type="checkbox" checked={group} onChange={e => setGroup(e.target.checked)} />Group lanes</label>
      <label><input type="checkbox" checked={heat} onChange={e => setHeat(e.target.checked)} />Capacity heat</label>
      <button type="button" onClick={() => host ? host.openPane('fleet-bus') : openDockPane('fleet-bus')}>Agent bus</button>
    </div>
    {mode === '3D' && <div className={styles.toolbar}>
      <label>Orbit <input aria-label="Orbit" type="range" min="-65" max="65" value={yaw} onChange={e => setYaw(Number(e.target.value))} /></label>
      <label>Tilt <input aria-label="Tilt" type="range" min="-35" max="35" value={tilt} onChange={e => setTilt(Number(e.target.value))} /></label>
      <label>Zoom <input aria-label="Zoom" type="range" min="0.4" max="1.5" step="0.05" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
    </div>}
    {[['Compute', compute], ['Sessions', sessions], ['Lanes', lanes], ['Org map', org]].map(([label, q]) => {
      const read = q as typeof compute;
      return read.status === 'error' ? <p key={String(label)} role="alert">{String(label)} refresh failed. {read.data ? 'Last reading retained; may be stale.' : 'No data available.'}</p> : null;
    })}
    <p>{data ? `Compute observed ${data.generatedAt} · ${recordedAt(data.generatedAt, now)}${data.truncated ? ' · partial inventory' : ''}` : 'No compute data yet.'}</p>
    <div className={styles.quota} aria-label="Lane quota strip">{!laneRows.length && <p>No lane observations.</p>}{laneRows.map(l => <article key={l.lane} data-state={laneQuotaState(l.hold?.held, data?.lanes[l.lane]?.quotaOk)}>
      <strong>{l.lane}</strong><span>{shown(l.liveJobs)} running / {shown(l.slotTarget)} target / {shown(data?.lanes[l.lane]?.hardCap)} hard cap</span>
      <span>{shown(l.queueDepth)} queued</span>
      <span>quota_ok: {data?.lanes[l.lane]?.quotaOk == null ? 'unknown' : String(data.lanes[l.lane]!.quotaOk)} · {l.credit.label}</span>
      <span>{l.hold?.held ? `HELD · ${l.hold.by ?? 'unknown'} · ${l.hold.reason ?? 'reason unknown'} · until ${l.hold.until ?? 'unknown'}` : l.hold ? 'No recorded hold' : 'Hold unknown'}</span>
      <small>Reset {l.credit.resetAt ?? 'unknown'} · {recordedAt(l.credit.observedAt, now)}</small>
    </article>) ?? <p>Lane quota: no data</p>}</div>
    {data && <PoolHosts data={data} now={now} />}
    {mode === '3D' && <ComputeScene3D nodes={nodes} jobs={jobs} orgMap={org.data ?? null} now={now3d} heat={heat} yaw={yaw} tilt={tilt} zoom={zoom}
      selection={selection} onSelect={select} onOrbit={(y, t) => { setYaw(y); setTilt(t); }} />}
    <details className={styles.viewport} open={mode === '2D' || undefined}>
      <summary>{mode === '2D' ? 'Machines' : 'Machine details (text)'}</summary>
      <div className={styles.scene}>
        {nodes.map(n => {
          const s = n.stats, current = fresh(s?.sampledAtMs, now), ceiling = s?.cores.length ? 2 * s.cores.length : null;
          const ratio = loadRatio(n, now);
          return <article className={styles.machine} key={n.id} data-heat={heat && ratio !== null ? heatBand(ratio) : 'unknown'}
            style={{ flexGrow: s ? 1 + s.cores.length / maxCores : 1 }}>
            <h3>{n.id}{n.local ? ' · this host' : ''}</h3><p>{n.state} · Heartbeat {n.heartbeatAt === null ? 'unknown' : recordedAt(n.heartbeatAt, now)}</p>
            <small>Metrics {s ? recordedAt(s.sampledAtMs, now) : 'unknown · no host-stats beat'}</small>
            <p>{s?.cores.length || 'unknown'} CPUs · Load 1/5/15: {s ? s.load.map(v => v === null ? 'unknown' : v.toFixed(1)).join(' / ') : 'unknown'}</p>
            <p>RAM {gib(s?.ramUsed)} / {gib(s?.ramTotal)} · Pressure {n.pressure ?? 'unknown'}</p>
            <p>Disk free {gib(s?.diskFree)} · Uptime {s ? `${Math.floor(s.uptimeSeconds / 3600)}h` : 'unknown'}</p>
            <CoreSparks history={history[n.id]} current={current} />
            <div className={styles.capacity}><span>Load ceiling (2 × CPU): {shown(ceiling)} · Slots {shown(n.slots)}{n.slots === 0 && n.state === 'ready' ? ' (held; reason not recorded)' : ''} · RAM slot ceiling {shown(n.ramSlots)}</span>
              <span>Caps: {n.caps?.length ? n.caps.join(', ') : 'unknown'}</span>
              <span>Memguard {n.memguardPaused === null ? 'unknown' : n.memguardPaused ? 'paused' : 'clear'}</span>
              {ratio === null ? <p>Headroom unknown · no fresh load reading</p> : <><meter aria-label={`${n.id} load versus ceiling`} min={0} max={1} optimum={0} low={HEAT_WARM} high={HEAT_HOT} value={Math.min(1, ratio)} /><small>{(ratio * 100).toFixed(0)}% of load ceiling · advisory; memory/slot gates remain independent</small></>}
            </div>
            {tokens(jobs.filter(j => location(j) === n.id))}
          </article>;
        })}
      </div>
    </details>
    {!nodes.length && <p>No nodes observed.</p>}
    <section aria-label="Unassigned agents"><h3>Queued / placement unknown</h3>{tokens(jobs.filter(j => location(j) === null || !nodes.some(n => n.id === location(j))))}</section>
    {mode === '2D' && <OrgMessages orgMap={org.data ?? null} />}
    {!jobs.length && <p>{sessions.data?.sourceState === 'healthy' ? 'No active sessions recorded.' : 'Session inventory unknown.'}</p>}
    {sessions.data && <p>Session placement uses compute observation {sessions.data.computeAt}.</p>}
    <p>Sessions: {sessions.data?.sourceState ?? 'unknown'}{sessions.data?.truncated ? ' · partial snapshot' : ''} · {recordedAt(sessions.data?.generatedAt, now)}. Dispatcher: {recordedAt(data?.dispatcherAt, now)}. {data && Object.entries(data.sources).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
    {selected && <AgentDetail key={selected.job} session={selected} node={nodes.find(n => n.id === location(selected))} enabled={enabled} close={() => select(null)}
      known={{ repo: row?.repo ?? null, startedAt: row?.startedAt ?? null, tokens: row?.tokensTotal ?? null }} openLog={() => { requestWorkerLogJob(selected.job); if (host) host.openPane('worker-log'); else openDockPane('worker-log'); }} />}
    {selection && !selected && <p role="status">Selected session left the active snapshot. See the job log for its outcome.</p>}
  </section>;
}
